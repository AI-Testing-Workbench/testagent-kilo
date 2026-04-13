package ai.kilocode.rpc.dto

import kotlinx.serialization.Serializable

@Serializable
enum class KiloProjectStatusDto {
    PENDING,
    LOADING,
    READY,
    ERROR,
}

@Serializable
data class KiloProjectLoadProgressDto(
    val providers: Boolean = false,
    val agents: Boolean = false,
    val commands: Boolean = false,
    val skills: Boolean = false,
)

@Serializable
data class KiloProjectStateDto(
    val status: KiloProjectStatusDto,
    val progress: KiloProjectLoadProgressDto? = null,
    val providers: ProvidersDto? = null,
    val agents: AgentsDto? = null,
    val commands: List<CommandDto> = emptyList(),
    val skills: List<SkillDto> = emptyList(),
    val error: String? = null,
)
