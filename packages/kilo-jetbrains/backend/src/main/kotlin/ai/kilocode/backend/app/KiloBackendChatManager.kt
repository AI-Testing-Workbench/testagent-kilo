package ai.kilocode.backend.app

import ai.kilocode.backend.cli.KiloCliDataParser
import ai.kilocode.backend.util.KiloLog
import ai.kilocode.rpc.dto.ChatEventDto
import ai.kilocode.rpc.dto.ConfigUpdateDto
import ai.kilocode.rpc.dto.MessageWithPartsDto
import ai.kilocode.rpc.dto.PermissionAlwaysRulesDto
import ai.kilocode.rpc.dto.PermissionReplyDto
import ai.kilocode.rpc.dto.PermissionRequestDto
import ai.kilocode.rpc.dto.PromptDto
import ai.kilocode.rpc.dto.QuestionReplyDto
import ai.kilocode.rpc.dto.QuestionRequestDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Chat orchestrator that handles message sending, history loading,
 * and SSE event routing for the agent chat UI.
 *
 * **Not an IntelliJ service** — owned by [KiloBackendAppService] which
 * calls [start] after [KiloAppState.Ready] and [stop] on disconnect.
 *
 * All JSON parsing is delegated to [KiloCliDataParser].
 */
class KiloBackendChatManager(
    private val cs: CoroutineScope,
    private val log: KiloLog,
) {
    companion object {
        private val JSON_TYPE = "application/json".toMediaType()

        private val CHAT_EVENTS = setOf(
            "message.updated",
            "message.removed",
            "message.part.updated",
            "message.part.delta",
            "message.part.removed",
            "session.turn.open",
            "session.turn.close",
            "session.error",
            "session.status",
            "session.idle",
            "session.compacted",
            "session.diff",
            "permission.asked",
            "permission.replied",
            "question.asked",
            "question.replied",
            "question.rejected",
            "todo.updated",
        )
    }

    private val _events = MutableSharedFlow<ChatEventDto>(extraBufferCapacity = 128)
    val events: SharedFlow<ChatEventDto> = _events.asSharedFlow()

    private var client: OkHttpClient? = null
    private var base: String? = null
    private var watcher: Job? = null

    fun start(http: OkHttpClient, port: Int, sse: SharedFlow<SseEvent>) {
        client = http
        base = "http://127.0.0.1:$port"
        if (watcher?.isActive == true) return
        watcher = cs.launch {
            sse.collect { event ->
                if (event.type in CHAT_EVENTS) {
                    log.debug("SSE chat event: type=${event.type}, data=${event.data.take(2000)}")
                    val parsed = KiloCliDataParser.parseChatEvent(event.type, event.data)
                    if (parsed != null) {
                        _events.emit(parsed)
                    } else {
                        log.warn("SSE parse returned null for type=${event.type}")
                    }
                }
            }
        }
        log.info("Chat manager started")
    }

    fun stop() {
        watcher?.cancel()
        watcher = null
        client = null
        base = null
        log.info("Chat manager stopped")
    }

    // ------ prompt ------

    fun prompt(id: String, dir: String, prompt: PromptDto) {
        log.info("prompt: session=$id, dir=$dir, parts=${prompt.parts.size}, agent=${prompt.agent}, model=${prompt.providerID}/${prompt.modelID}")
        val http = requireClient()
        val url = requireBase()

        val body = KiloCliDataParser.buildPromptJson(prompt)
        val target = "$url/session/$id/prompt_async?directory=${encode(dir)}"
        log.debug("prompt: POST $target, body=$body")
        val request = Request.Builder()
            .url(target)
            .post(body.toRequestBody(JSON_TYPE))
            .build()

        try {
            http.newCall(request).execute().use { response ->
                val code = response.code
                if (!response.isSuccessful) {
                    val raw = response.body?.string()
                    log.warn("prompt_async failed: HTTP $code")
                    log.debug("prompt_async error body: $raw")
                    throw RuntimeException("prompt_async failed: HTTP $code")
                }
            }
        } catch (e: RuntimeException) {
            throw e
        } catch (e: Exception) {
            log.warn("prompt: HTTP call threw exception", e)
            throw RuntimeException("prompt_async HTTP call failed: ${e.message}", e)
        }
    }

    // ------ abort ------

    fun abort(id: String, dir: String) {
        val http = requireClient()
        val url = requireBase()

        val request = Request.Builder()
            .url("$url/session/$id/abort?directory=${encode(dir)}")
            .post("".toRequestBody(JSON_TYPE))
            .build()

        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("abort failed: HTTP ${response.code}")
            }
        }
    }

    // ------ messages ------

    fun messages(id: String, dir: String): List<MessageWithPartsDto> {
        val http = requireClient()
        val url = requireBase()

        val request = Request.Builder()
            .url("$url/session/$id/message?directory=${encode(dir)}")
            .get()
            .build()

        return http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("messages failed: HTTP ${response.code}")
                return emptyList()
            }
            val raw = response.body?.string() ?: return emptyList()
            KiloCliDataParser.parseMessages(raw)
        }
    }

    // ------ config update ------

    fun updateConfig(dir: String, update: ConfigUpdateDto) {
        val http = requireClient()
        val url = requireBase()

        val partial = KiloCliDataParser.buildConfigPartial(update)

        val request = Request.Builder()
            .url("$url/global/config")
            .patch(partial.toRequestBody(JSON_TYPE))
            .build()

        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val msg = response.body?.string() ?: "unknown error"
                log.warn("config update failed: HTTP ${response.code} — $msg")
            } else {
                log.info("Config updated: model=${update.model}, agent=${update.agent}, temp=${update.temperature}")
            }
        }
    }

    // ------ permission / question ------

    fun replyPermission(requestId: String, dir: String, reply: PermissionReplyDto) {
        val body = KiloCliDataParser.buildPermissionReplyJson(reply)
        post("/permission/$requestId/reply?directory=${encode(dir)}", body, "replyPermission")
    }

    fun savePermissionRules(requestId: String, dir: String, rules: PermissionAlwaysRulesDto) {
        val body = KiloCliDataParser.buildPermissionAlwaysRulesJson(rules)
        post("/permission/$requestId/always-rules?directory=${encode(dir)}", body, "savePermissionRules")
    }

    fun replyQuestion(requestId: String, dir: String, answers: QuestionReplyDto) {
        val body = KiloCliDataParser.buildQuestionReplyJson(answers)
        post("/question/$requestId/reply?directory=${encode(dir)}", body, "replyQuestion")
    }

    fun rejectQuestion(requestId: String, dir: String) {
        post("/question/$requestId/reject?directory=${encode(dir)}", "{}", "rejectQuestion")
    }

    fun pendingPermissions(dir: String): List<PermissionRequestDto> {
        val raw = get("/permission?directory=${encode(dir)}", "pendingPermissions") ?: return emptyList()
        return KiloCliDataParser.parsePermissionRequests(raw)
    }

    fun pendingQuestions(dir: String): List<QuestionRequestDto> {
        val raw = get("/question?directory=${encode(dir)}", "pendingQuestions") ?: return emptyList()
        return KiloCliDataParser.parseQuestionRequests(raw)
    }

    // ------ utilities ------

    private fun post(path: String, body: String, op: String) {
        val http = requireClient()
        val url = requireBase()
        val request = Request.Builder()
            .url("$url$path")
            .post(body.toRequestBody(JSON_TYPE))
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("$op failed: HTTP ${response.code}")
            }
        }
    }

    private fun get(path: String, op: String): String? {
        val http = requireClient()
        val url = requireBase()
        val request = Request.Builder()
            .url("$url$path")
            .get()
            .build()
        return http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("$op failed: HTTP ${response.code}")
                null
            } else {
                response.body?.string()
            }
        }
    }

    private fun requireClient(): OkHttpClient =
        client ?: throw IllegalStateException("Chat manager not started")

    private fun requireBase(): String =
        base ?: throw IllegalStateException("Chat manager not started")

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8")
}
