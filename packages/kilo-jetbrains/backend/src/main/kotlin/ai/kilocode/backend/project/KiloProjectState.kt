package ai.kilocode.backend.project

/**
 * Full project data lifecycle state, combining connection readiness
 * with project-scoped data loading progress.
 *
 * Only populated after [KiloAppState.Ready][ai.kilocode.backend.app.KiloAppState.Ready]
 * — the CLI server must be connected and global data loaded before
 * project data can be fetched.
 */
sealed class KiloProjectState {
    data object Pending : KiloProjectState()
    data class Loading(val progress: KiloProjectLoadProgress) : KiloProjectState()
    data class Ready(
        val providers: ProviderData,
        val agents: AgentData,
        val commands: List<CommandInfo>,
        val skills: List<SkillInfo>,
    ) : KiloProjectState()
    data class Error(val message: String) : KiloProjectState()
}

/**
 * Tracks which project data fetches have completed during
 * the [KiloProjectState.Loading] phase.
 */
data class KiloProjectLoadProgress(
    val providers: Boolean = false,
    val agents: Boolean = false,
    val commands: Boolean = false,
    val skills: Boolean = false,
)

data class ProviderData(
    val providers: List<ProviderInfo>,
    val connected: List<String>,
    val defaults: Map<String, String>,
)

data class ProviderInfo(
    val id: String,
    val name: String,
    val source: String?,
    val models: Map<String, ModelInfo>,
)

data class ModelInfo(
    val id: String,
    val name: String,
    val attachment: Boolean,
    val reasoning: Boolean,
    val temperature: Boolean,
    val toolCall: Boolean,
    val free: Boolean,
    val status: String?,
)

data class AgentData(
    val agents: List<AgentInfo>,
    val all: List<AgentInfo>,
    val default: String,
)

data class AgentInfo(
    val name: String,
    val displayName: String?,
    val description: String?,
    val mode: String,
    val native: Boolean?,
    val hidden: Boolean?,
    val color: String?,
    val deprecated: Boolean?,
)

data class CommandInfo(
    val name: String,
    val description: String?,
    val source: String?,
    val hints: List<String>,
)

data class SkillInfo(
    val name: String,
    val description: String,
    val location: String,
)
