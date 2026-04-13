package ai.kilocode.backend.project

import ai.kilocode.backend.app.KiloAppState
import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.util.IntellijLog
import ai.kilocode.backend.util.KiloLog
import ai.kilocode.jetbrains.api.client.DefaultApi
import ai.kilocode.jetbrains.api.model.Agent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * Project-level backend service that loads project-scoped data
 * from the CLI server when the app reaches [KiloAppState.Ready].
 *
 * Watches [KiloBackendAppService.appState] and triggers parallel
 * data fetches for providers, agents, commands, and skills.
 * Progress is tracked via [KiloProjectLoadProgress] and emitted as
 * [KiloProjectState.Loading] → [KiloProjectState.Ready] or [KiloProjectState.Error].
 *
 * Each fetch is retried up to [MAX_RETRIES] times, matching the
 * pattern in [KiloBackendAppService].
 */
@Service(Service.Level.PROJECT)
class KiloBackendProjectService(
    private val project: Project,
    private val cs: CoroutineScope,
) {
    companion object {
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 1000L
    }

    /** Project working directory sent as the `directory` parameter. */
    val directory: String
        get() = project.basePath ?: ""

    private val log: KiloLog = IntellijLog(KiloBackendProjectService::class.java)

    private val _state = MutableStateFlow<KiloProjectState>(KiloProjectState.Pending)
    val state: StateFlow<KiloProjectState> = _state.asStateFlow()

    private var loader: Job? = null

    init {
        cs.launch {
            service<KiloBackendAppService>().appState.collect { state ->
                when (state) {
                    is KiloAppState.Ready -> load()
                    is KiloAppState.Disconnected,
                    is KiloAppState.Connecting -> {
                        loader?.cancel()
                        _state.value = KiloProjectState.Pending
                    }
                    is KiloAppState.Error -> {
                        loader?.cancel()
                        _state.value = KiloProjectState.Pending
                    }
                    is KiloAppState.Loading -> { /* wait for Ready */ }
                }
            }
        }
    }

    /** Force a full reload of all project data. */
    suspend fun reload() {
        load()
    }

    /**
     * Launch all project data fetches in parallel.
     *
     * Each resource is retried up to [MAX_RETRIES] times.
     * Progress is tracked via [AtomicReference] and emitted
     * as [KiloProjectState.Loading].
     */
    private fun load() {
        loader?.cancel()
        loader = cs.launch {
            val dir = directory
            val api = service<KiloBackendAppService>().api
            if (api == null) {
                _state.value = KiloProjectState.Error("CLI server not connected")
                return@launch
            }

            log.info("Loading project data for $dir")
            val progress = AtomicReference(KiloProjectLoadProgress())
            _state.value = KiloProjectState.Loading(progress.get())

            val errors = mutableListOf<String>()

            try {
                coroutineScope {
                    launch {
                        val result = fetchWithRetry("providers") { fetchProviders(api, dir) }
                        if (result != null) {
                            progress.updateAndGet { it.copy(providers = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("providers") }
                            throw LoadFailure("providers")
                        }
                    }
                    launch {
                        val result = fetchWithRetry("agents") { fetchAgents(api, dir) }
                        if (result != null) {
                            progress.updateAndGet { it.copy(agents = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("agents") }
                            throw LoadFailure("agents")
                        }
                    }
                    launch {
                        val result = fetchWithRetry("commands") { fetchCommands(api, dir) }
                        if (result != null) {
                            progress.updateAndGet { it.copy(commands = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("commands") }
                            throw LoadFailure("commands")
                        }
                    }
                    launch {
                        val result = fetchWithRetry("skills") { fetchSkills(api, dir) }
                        if (result != null) {
                            progress.updateAndGet { it.copy(skills = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("skills") }
                            throw LoadFailure("skills")
                        }
                    }
                }

                // All succeeded — assemble Ready state
                _state.value = KiloProjectState.Ready(
                    providers = providers!!,
                    agents = agents!!,
                    commands = commands!!,
                    skills = skills!!,
                )
                log.info("Project data loaded for $dir")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.warn("Project data load failed for $dir: ${e.message}")
                _state.value = KiloProjectState.Error(
                    "Failed to load: ${synchronized(errors) { errors.joinToString() }}"
                )
            }
        }
    }

    // ------ cached results from each fetch ------

    @Volatile private var providers: ProviderData? = null
    @Volatile private var agents: AgentData? = null
    @Volatile private var commands: List<CommandInfo>? = null
    @Volatile private var skills: List<SkillInfo>? = null

    // ------ individual fetch methods ------

    private fun fetchProviders(api: DefaultApi, dir: String): ProviderData? =
        try {
            val response = api.providerList(directory = dir)
            val mapped = response.all.map { p ->
                ProviderInfo(
                    id = p.id,
                    name = p.name,
                    source = p.api,
                    models = p.models.mapValues { (_, m) ->
                        ModelInfo(
                            id = m.id,
                            name = m.name,
                            attachment = m.attachment,
                            reasoning = m.reasoning,
                            temperature = m.temperature,
                            toolCall = m.toolCall,
                            free = m.isFree ?: false,
                            status = m.status?.value,
                        )
                    },
                )
            }
            ProviderData(
                providers = mapped,
                connected = response.connected,
                defaults = response.default,
            ).also { providers = it }
        } catch (e: Exception) {
            log.warn("Providers fetch failed: ${e.message}", e)
            null
        }

    private fun fetchAgents(api: DefaultApi, dir: String): AgentData? =
        try {
            val response = api.appAgents(directory = dir)
            val mapped = response.map(::mapAgent)
            val visible = response.filter { it.mode != Agent.Mode.SUBAGENT && it.hidden != true }
            val default = visible.firstOrNull()?.name ?: "code"
            AgentData(
                agents = visible.map(::mapAgent),
                all = mapped,
                default = default,
            ).also { agents = it }
        } catch (e: Exception) {
            log.warn("Agents fetch failed: ${e.message}", e)
            null
        }

    private fun fetchCommands(api: DefaultApi, dir: String): List<CommandInfo>? =
        try {
            api.commandList(directory = dir).map { c ->
                CommandInfo(
                    name = c.name,
                    description = c.description,
                    source = c.source?.value,
                    hints = c.hints,
                )
            }.also { commands = it }
        } catch (e: Exception) {
            log.warn("Commands fetch failed: ${e.message}", e)
            null
        }

    private fun fetchSkills(api: DefaultApi, dir: String): List<SkillInfo>? =
        try {
            api.appSkills(directory = dir).map { s ->
                SkillInfo(
                    name = s.name,
                    description = s.description,
                    location = s.location,
                )
            }.also { skills = it }
        } catch (e: Exception) {
            log.warn("Skills fetch failed: ${e.message}", e)
            null
        }

    // ------ helpers ------

    private fun mapAgent(a: Agent) = AgentInfo(
        name = a.name,
        displayName = a.displayName,
        description = a.description,
        mode = a.mode.value,
        native = a.native,
        hidden = a.hidden,
        color = a.color,
        deprecated = a.deprecated,
    )

    private suspend fun <T> fetchWithRetry(
        name: String,
        block: () -> T?,
    ): T? {
        repeat(MAX_RETRIES) { attempt ->
            val result = block()
            if (result != null) return result
            if (attempt < MAX_RETRIES - 1) {
                log.warn("$name: attempt ${attempt + 1}/$MAX_RETRIES failed — retrying in ${RETRY_DELAY_MS}ms")
                delay(RETRY_DELAY_MS)
            }
        }
        log.error("$name: all $MAX_RETRIES attempts failed")
        return null
    }

    private class LoadFailure(resource: String) : Exception("Failed to load $resource")
}
