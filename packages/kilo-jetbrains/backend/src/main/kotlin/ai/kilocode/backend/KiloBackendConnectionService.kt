package ai.kilocode.backend

import ai.kilocode.jetbrains.api.client.DefaultApi
import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data object Connecting : ConnectionState()
    data class Connected(val port: Int, val password: String) : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

data class SseEvent(val type: String, val data: String)

/**
 * Manages the CLI server connection: SSE stream, health polling, heartbeat,
 * and automatic reconnection.
 *
 * Uses two separate OkHttp clients mirroring the VS Code architecture:
 * - [apiClient]: no call/read timeout — used for the generated API client and SSE
 * - [healthClient]: 3 s timeout — used only for `/global/health` polling
 *
 * The generated [DefaultApi] is configured with [apiClient] and exposed via [api]
 * for typed access to all CLI server endpoints.
 *
 * Concurrency is handled by the owning [KiloBackendAppService] — `connect`,
 * `restart`, and `reinstall` are called under its mutex. Internal reconnect
 * attempts delegate back to the owner via [onReconnect].
 *
 * Not a service — owned and instantiated by [KiloBackendAppService].
 */
class KiloConnectionService(
    private val cs: CoroutineScope,
    private val server: KiloBackendCliManager,
    private val onReconnect: () -> Unit,
) {

    companion object {
        private val LOG = Logger.getInstance(KiloConnectionService::class.java)
        private const val HEARTBEAT_TIMEOUT_MS = 15_000L
        private const val HEALTH_POLL_INTERVAL_MS = 10_000L
        private const val RECONNECT_DELAY_MS = 250L
        private val TYPE_REGEX = Regex(""""type"\s*:\s*"([^"]+)"""")
    }

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<SseEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<SseEvent> = _events.asSharedFlow()

    /** Generated API client — null when disconnected. */
    var api: DefaultApi? = null
        private set

    private var apiClient: OkHttpClient? = null
    private var healthClient: OkHttpClient? = null
    private var port = 0
    private var password = ""

    private val source = AtomicReference<EventSource?>(null)
    private val lastEvent = AtomicLong(0L)
    private var heartbeatJob: Job? = null
    private var healthJob: Job? = null
    private var processJob: Job? = null
    private var reconnectJob: Job? = null

    /**
     * Open a connection to the CLI server.
     *
     * Called under [KiloBackendAppService]'s mutex — no internal guard needed.
     */
    suspend fun connect() {
        open()
    }

    /**
     * Kill the CLI process and restart it. Tears down all connections first.
     *
     * Called under [KiloBackendAppService]'s mutex.
     */
    suspend fun restart() {
        LOG.info("restart: initiated — tearing down current connection")
        teardown()
        LOG.info("restart: teardown complete — spawning new CLI process")
        open()
        LOG.info("restart: open() returned — CLI process started")
    }

    /**
     * Kill the CLI process, re-extract the binary from JAR, and restart.
     *
     * Called under [KiloBackendAppService]'s mutex.
     */
    suspend fun reinstall() {
        LOG.info("reinstall: initiated — tearing down current connection")
        teardown()
        LOG.info("reinstall: teardown complete — setting forceExtract flag")
        server.forceExtract = true
        LOG.info("reinstall: spawning new CLI process (binary will be re-extracted)")
        open()
        LOG.info("reinstall: open() returned — CLI process started with fresh binary")
    }

    /**
     * Full teardown: cancel all jobs, close SSE, shutdown HTTP clients, kill process.
     *
     * Order matters — reconnect/health/heartbeat jobs are cancelled first so they
     * cannot race with the SSE close or process kill.
     */
    private fun teardown() {
        LOG.info("teardown: cancelling background jobs (reconnect, heartbeat, health, process)")
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        healthJob?.cancel()
        processJob?.cancel()
        LOG.info("teardown: closing SSE event source")
        source.getAndSet(null)?.cancel()
        LOG.info("teardown: shutting down OkHttp clients")
        close()
        setState(ConnectionState.Disconnected)
        LOG.info("teardown: killing CLI process via ServerManager.stop()")
        server.stop()
        LOG.info("teardown: complete")
    }

    private suspend fun open() {
        source.getAndSet(null)?.cancel()
        close()
        processJob?.cancel()
        healthJob?.cancel()

        setState(ConnectionState.Connecting)

        val result = server.init()

        if (result is KiloBackendCliManager.ServerState.Error) {
            setState(ConnectionState.Error(result.message))
            return
        }

        val ready = result as KiloBackendCliManager.ServerState.Ready
        port = ready.port
        password = ready.password

        // Create dual OkHttp clients (bundled — no IntelliJ platform deps)
        val ac = KiloBackendHttpClients.api(password)
        val hc = KiloBackendHttpClients.health(password)
        apiClient = ac
        healthClient = hc

        // Configure generated API client with the no-timeout api client
        api = DefaultApi(basePath = "http://127.0.0.1:$port", client = ac)

        startSse()
        startHeartbeatWatcher()
        healthJob = healthLoop()
        server.process()?.let { proc ->
            processJob = monitorProcess(proc)
        }
    }

    private fun startSse() {
        val http = apiClient ?: return
        val request = Request.Builder()
            .url("http://127.0.0.1:$port/global/event")
            .header("Accept", "text/event-stream")
            .build()

        val factory = EventSources.createFactory(
            http.newBuilder()
                .callTimeout(0, TimeUnit.MILLISECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build()
        )
        source.set(factory.newEventSource(request, listener))
        LOG.info("SSE: connecting to port $port")
    }

    private val listener = object : EventSourceListener() {
        override fun onOpen(src: EventSource, response: Response) {
            LOG.info("SSE: connected")
            setState(ConnectionState.Connected(port, password))
            lastEvent.set(System.currentTimeMillis())
        }

        override fun onEvent(src: EventSource, id: String?, type: String?, data: String) {
            lastEvent.set(System.currentTimeMillis())
            val kind = type ?: extractType(data)
            cs.launch { _events.emit(SseEvent(type = kind, data = data)) }
        }

        override fun onClosed(src: EventSource) {
            LOG.info("SSE: stream closed — scheduling reconnect")
            scheduleReconnect()
        }

        override fun onFailure(src: EventSource, t: Throwable?, response: Response?) {
            if (t != null) {
                LOG.warn("SSE: failure (${t.message}) — scheduling reconnect")
            } else {
                LOG.warn("SSE: failure (HTTP ${response?.code}) — scheduling reconnect")
            }
            setState(ConnectionState.Error(t?.message ?: "SSE connection failed (HTTP ${response?.code})"))
            scheduleReconnect()
        }
    }

    /**
     * Schedule a reconnect attempt. If the CLI process is still alive,
     * just reconnect SSE. Otherwise, delegate to [onReconnect] which
     * goes through [KiloBackendAppService]'s mutex for a full restart.
     */
    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        reconnectJob = cs.launch {
            delay(RECONNECT_DELAY_MS)
            if (!isActive) return@launch

            val proc = server.process()

            if (proc?.isAlive == true) {
                LOG.info("SSE: reconnecting (process alive)")
                source.getAndSet(null)?.cancel()
                setState(ConnectionState.Connecting)
                startSse()
                return@launch
            }

            LOG.warn("CLI process not running — delegating full reconnect to AppService")
            onReconnect()
        }
    }

    private fun startHeartbeatWatcher() {
        heartbeatJob?.cancel()
        heartbeatJob = cs.launch {
            while (isActive) {
                delay(1_000)
                if (_state.value !is ConnectionState.Connected) continue
                val elapsed = System.currentTimeMillis() - lastEvent.get()
                if (elapsed > HEARTBEAT_TIMEOUT_MS) {
                    LOG.warn("SSE: heartbeat timeout (${elapsed}ms) — forcing reconnect")
                    source.getAndSet(null)?.cancel()
                    scheduleReconnect()
                }
            }
        }
    }

    private fun healthLoop() = cs.launch(Dispatchers.IO) {
        while (isActive) {
            delay(HEALTH_POLL_INTERVAL_MS)
            if (_state.value !is ConnectionState.Connected) continue
            val ok = checkHealth()
            if (!ok && _state.value is ConnectionState.Connected) {
                LOG.warn("Health check failed — forcing SSE reconnect")
                source.getAndSet(null)?.cancel()
                scheduleReconnect()
            }
        }
    }

    private fun checkHealth(): Boolean {
        val http = healthClient ?: return false
        return try {
            val req = Request.Builder()
                .url("http://127.0.0.1:$port/global/health")
                .build()
            http.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            LOG.info("Health check exception: ${e.message}")
            false
        }
    }

    private fun monitorProcess(proc: Process) = cs.launch(Dispatchers.IO) {
        proc.waitFor()
        server.exited(proc)
        val code = proc.exitValue()
        LOG.warn("CLI process exited with code $code")
        source.getAndSet(null)?.cancel()
        setState(ConnectionState.Error("CLI process exited with code $code"))
        scheduleReconnect()
    }

    private fun close() {
        api = null
        apiClient?.let { KiloBackendHttpClients.shutdown(it) }
        apiClient = null
        healthClient?.let { KiloBackendHttpClients.shutdown(it) }
        healthClient = null
    }

    private fun setState(next: ConnectionState) {
        _state.value = next
    }

    private fun extractType(data: String): String =
        TYPE_REGEX.find(data)?.groupValues?.get(1) ?: "unknown"

    fun dispose() {
        source.getAndSet(null)?.cancel()
        heartbeatJob?.cancel()
        healthJob?.cancel()
        processJob?.cancel()
        reconnectJob?.cancel()
        close()
        setState(ConnectionState.Disconnected)
        LOG.info("KiloConnectionService disposed")
    }
}
