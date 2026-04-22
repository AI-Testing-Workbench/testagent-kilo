package ai.kilocode.client.session.model

import ai.kilocode.rpc.dto.DiffFileDto
import ai.kilocode.rpc.dto.KiloAppStateDto
import ai.kilocode.rpc.dto.KiloAppStatusDto
import ai.kilocode.rpc.dto.KiloWorkspaceStateDto
import ai.kilocode.rpc.dto.KiloWorkspaceStatusDto
import ai.kilocode.rpc.dto.MessageDto
import ai.kilocode.rpc.dto.MessageWithPartsDto
import ai.kilocode.rpc.dto.PartDto
import ai.kilocode.rpc.dto.TodoDto
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer

/**
 * Pure session model — single source of truth for session content and runtime state.
 *
 * **EDT-only access** — no synchronization. [ai.kilocode.client.session.SessionController] guarantees all
 * reads and writes happen on the EDT.
 */
class SessionModel {

    private val entries = LinkedHashMap<String, Message>()

    var app: KiloAppStateDto = KiloAppStateDto(KiloAppStatusDto.DISCONNECTED)
    var version: String? = null

    var workspace: KiloWorkspaceStateDto = KiloWorkspaceStateDto(KiloWorkspaceStatusDto.PENDING)
    var agents: List<AgentItem> = emptyList()
    var models: List<ModelItem> = emptyList()
    var agent: String? = null
    var model: String? = null
    var showMessages: Boolean = false

    var state: SessionState = SessionState.Idle
        private set

    var diff: List<DiffFileDto> = emptyList()
        private set

    var todos: List<TodoDto> = emptyList()
        private set

    var compactionCount: Int = 0
        private set

    private val listeners = mutableListOf<SessionModelEvent.Listener>()

    fun addListener(parent: Disposable, listener: SessionModelEvent.Listener) {
        listeners.add(listener)
        Disposer.register(parent) { listeners.remove(listener) }
    }

    fun messages(): Collection<Message> = entries.values

    fun message(id: String): Message? = entries[id]

    fun content(messageId: String, contentId: String): Content? = entries[messageId]?.parts?.get(contentId)

    fun isEmpty(): Boolean = entries.isEmpty()

    fun isReady(): Boolean = app.status == KiloAppStatusDto.READY && workspace.status == KiloWorkspaceStatusDto.READY

    /**
     * Add a message if it doesn't exist, or update its [MessageDto] info if it does.
     * Returns true when the message was newly added (caller can decide to show messages).
     */
    fun upsertMessage(dto: MessageDto): Boolean {
        val existing = entries[dto.id]
        if (existing != null) {
            val updated = Message(dto).also { it.parts.putAll(existing.parts) }
            entries[dto.id] = updated
            fire(SessionModelEvent.MessageUpdated(updated))
            return false
        }
        val msg = Message(dto)
        entries[dto.id] = msg
        fire(SessionModelEvent.MessageAdded(msg))
        return true
    }

    /** @deprecated Use [upsertMessage] instead. Kept for incremental migration. */
    fun addMessage(dto: MessageDto): Message? {
        if (entries.containsKey(dto.id)) return null
        val msg = Message(dto)
        entries[dto.id] = msg
        fire(SessionModelEvent.MessageAdded(msg))
        return msg
    }

    fun removeMessage(id: String) {
        if (entries.remove(id) == null) return
        fire(SessionModelEvent.MessageRemoved(id))
    }

    fun removeContent(messageId: String, contentId: String) {
        val msg = entries[messageId] ?: return
        if (msg.parts.remove(contentId) == null) return
        fire(SessionModelEvent.ContentRemoved(messageId, contentId))
    }

    fun updateContent(messageId: String, dto: PartDto) {
        val msg = entries[messageId] ?: return
        val existing = msg.parts[dto.id]
        if (existing != null) {
            updateExisting(messageId, existing, dto)
            return
        }
        val content = fromDto(dto)
        msg.parts[dto.id] = content
        fire(SessionModelEvent.ContentAdded(messageId, content))
    }

    fun appendDelta(messageId: String, contentId: String, delta: String) {
        val msg = entries[messageId] ?: return
        val existing = msg.parts[contentId]
        if (existing != null) {
            val buf = when (existing) {
                is Text -> existing.content
                is Reasoning -> existing.content
                else -> return
            }
            buf.append(delta)
        } else {
            val content = Text(contentId)
            content.content.append(delta)
            msg.parts[contentId] = content
            fire(SessionModelEvent.ContentAdded(messageId, content))
        }
        fire(SessionModelEvent.ContentDelta(messageId, contentId, delta))
    }

    fun setState(state: SessionState) {
        this.state = state
        fire(SessionModelEvent.StateChanged(state))
    }

    fun setDiff(diff: List<DiffFileDto>) {
        this.diff = diff
        fire(SessionModelEvent.DiffUpdated(diff))
    }

    fun setTodos(todos: List<TodoDto>) {
        this.todos = todos
        fire(SessionModelEvent.TodosUpdated(todos))
    }

    fun markCompacted() {
        compactionCount++
        fire(SessionModelEvent.Compacted(compactionCount))
    }

    fun loadHistory(history: List<MessageWithPartsDto>) {
        entries.clear()
        state = SessionState.Idle
        diff = emptyList()
        todos = emptyList()
        compactionCount = 0
        for (msg in history) {
            val item = Message(msg.info)
            for (part in msg.parts) {
                val content = fromDto(part, part.text)
                item.parts[content.id] = content
            }
            entries[msg.info.id] = item
        }
        fire(SessionModelEvent.HistoryLoaded)
    }

    fun clear() {
        entries.clear()
        state = SessionState.Idle
        diff = emptyList()
        todos = emptyList()
        compactionCount = 0
        fire(SessionModelEvent.Cleared)
    }

    private fun updateExisting(messageId: String, existing: Content, dto: PartDto) {
        when (existing) {
            is Text -> {
                val text = dto.text ?: return
                existing.content.clear()
                existing.content.append(text)
            }
            is Reasoning -> {
                val text = dto.text ?: return
                existing.content.clear()
                existing.content.append(text)
            }
            is Tool -> {
                existing.state = parseToolState(dto.state)
                existing.title = dto.title
            }
            is Compaction -> return
            is Generic -> return
        }
        fire(SessionModelEvent.ContentUpdated(messageId, existing))
    }

    private fun fromDto(dto: PartDto, text: CharSequence? = null): Content {
        val content = text ?: dto.text
        return when (dto.type) {
            "text" -> Text(dto.id).apply {
                if (content != null && content.isNotEmpty()) this.content.append(content)
            }
            "reasoning" -> Reasoning(dto.id).apply {
                if (content != null && content.isNotEmpty()) this.content.append(content)
            }
            "tool" -> Tool(dto.id, dto.tool ?: "unknown").apply {
                state = parseToolState(dto.state)
                title = dto.title
            }
            "compaction" -> Compaction(dto.id)
            else -> Generic(dto.id, dto.type)
        }
    }

    private fun fire(event: SessionModelEvent) {
        for (l in listeners) l.onEvent(event)
    }

    override fun toString(): String {
        val out = mutableListOf<String>()

        for (msg in messages()) {
            if (out.isNotEmpty()) out.add("---")
            out.addAll(renderMessage(msg))
        }

        when (val state = this.state) {
            is SessionState.AwaitingQuestion -> {
                if (out.isNotEmpty()) out.add("---")
                out.addAll(renderQuestion(state.question))
            }
            is SessionState.AwaitingPermission -> {
                if (out.isNotEmpty()) out.add("---")
                out.addAll(renderPermission(state.permission))
            }
            else -> {}
        }

        if (diff.isNotEmpty()) {
            if (out.isNotEmpty()) out.add("---")
            out.add("diff: ${diff.joinToString(" ") { it.file }}")
        }
        if (todos.isNotEmpty()) {
            if (out.isNotEmpty()) out.add("---")
            todos.forEach { out.add("todo: [${it.status}] ${it.content}") }
        }
        if (compactionCount > 0) {
            if (out.isNotEmpty()) out.add("---")
            out.add("compacted: $compactionCount")
        }

        return out.joinToString("\n")
    }
}

private fun parseToolState(raw: String?): ToolExecState = when (raw) {
    "pending" -> ToolExecState.PENDING
    "running" -> ToolExecState.RUNNING
    "completed" -> ToolExecState.COMPLETED
    "error" -> ToolExecState.ERROR
    else -> ToolExecState.PENDING
}

data class AgentItem(val name: String, val display: String)

data class ModelItem(val id: String, val display: String, val provider: String)

private fun renderMessage(msg: Message): List<String> {
    val out = mutableListOf<String>()
    out.add("${msg.info.role}#${msg.info.id}")
    for (part in msg.parts.values) {
        when (part) {
            is Text -> {
                out.add("text#${part.id}:")
                out.addAll(renderText(part.content))
            }
            is Reasoning -> {
                out.add("reasoning#${part.id}:")
                out.addAll(renderText(part.content))
            }
            is Tool -> out.add(renderTool(part))
            is Compaction -> out.add("compaction#${part.id}")
            is Generic -> out.add("${part.type}#${part.id}")
        }
    }
    return out
}

private fun renderQuestion(question: Question): List<String> {
    val out = mutableListOf<String>()
    out.add("question#${question.id}")
    out.add("tool: ${renderToolRef(question.tool)}")
    for (item in question.items) {
        out.add("header: ${item.header}")
        out.add("prompt: ${item.question}")
        for (opt in item.options) {
            out.add("option: ${opt.label} - ${opt.description}")
        }
        out.add("multiple: ${item.multiple}")
        out.add("custom: ${item.custom}")
    }
    return out
}

private fun renderPermission(permission: Permission): List<String> {
    val out = mutableListOf<String>()
    out.add("permission#${permission.id}")
    out.add("tool: ${renderToolRef(permission.tool)}")
    out.add("name: ${permission.name}")
    out.add("patterns: ${permission.patterns.joinToString(", ").ifEmpty { "<none>" }}")
    out.add("always: ${permission.always.joinToString(", ").ifEmpty { "<none>" }}")
    out.add("file: ${renderFile(permission.meta)}")
    out.add("state: ${permission.state.name}")
    val meta = permission.meta.raw.entries
        .filter { it.key !in setOf("file", "path", "state") }
        .sortedBy { it.key }
        .joinToString(", ") { "${it.key}=${it.value}" }
        .ifEmpty { "<none>" }
    out.add("metadata: $meta")
    return out
}

private fun renderToolRef(ref: ToolCallRef?): String = ref?.let { "${it.messageId}/${it.callId}" } ?: "<none>"

private fun renderFile(meta: PermissionMeta): String {
    meta.filePath?.takeIf { it.isNotBlank() }?.let { return it }
    meta.raw["file"]?.takeIf { it.isNotBlank() }?.let { return it }
    meta.raw["path"]?.takeIf { it.isNotBlank() }?.let { return it }
    return "<none>"
}

private fun renderTool(tool: Tool): String {
    val state = tool.state.name
    val title = tool.title?.takeIf { it.isNotBlank() }?.let { " $it" } ?: ""
    return "tool#${tool.id} ${tool.name} [$state]$title"
}

private fun renderText(text: CharSequence): List<String> {
    val raw = text.toString()
    if (raw.isEmpty()) return listOf("  <empty>")
    return raw.split("\n").map { "  $it" }
}
