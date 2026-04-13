@file:Suppress("UnstableApiUsage")

package ai.kilocode.backend.rpc

import ai.kilocode.backend.project.AgentData
import ai.kilocode.backend.project.AgentInfo
import ai.kilocode.backend.project.CommandInfo
import ai.kilocode.backend.project.KiloBackendProjectService
import ai.kilocode.backend.project.KiloProjectLoadProgress
import ai.kilocode.backend.project.KiloProjectState
import ai.kilocode.backend.project.ModelInfo
import ai.kilocode.backend.project.ProviderData
import ai.kilocode.backend.project.ProviderInfo
import ai.kilocode.backend.project.SkillInfo
import ai.kilocode.rpc.KiloProjectRpcApi
import ai.kilocode.rpc.dto.AgentDto
import ai.kilocode.rpc.dto.AgentsDto
import ai.kilocode.rpc.dto.CommandDto
import ai.kilocode.rpc.dto.KiloProjectLoadProgressDto
import ai.kilocode.rpc.dto.KiloProjectStateDto
import ai.kilocode.rpc.dto.KiloProjectStatusDto
import ai.kilocode.rpc.dto.ModelDto
import ai.kilocode.rpc.dto.ProviderDto
import ai.kilocode.rpc.dto.ProvidersDto
import ai.kilocode.rpc.dto.SkillDto
import com.intellij.openapi.components.service
import com.intellij.openapi.project.ProjectManager
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

/**
 * Backend implementation of [KiloProjectRpcApi].
 *
 * Looks up the correct [KiloBackendProjectService] by directory
 * and maps its internal domain model to shared DTOs.
 */
class KiloProjectRpcApiImpl : KiloProjectRpcApi {

    override suspend fun state(directory: String): Flow<KiloProjectStateDto> {
        val svc = find(directory)
            ?: return flowOf(KiloProjectStateDto(
                status = KiloProjectStatusDto.ERROR,
                error = "Project not found for directory: $directory",
            ))
        return svc.state
            .map(::dto)
            .distinctUntilChanged()
    }

    override suspend fun reload(directory: String) {
        find(directory)?.reload()
    }

    private fun find(directory: String): KiloBackendProjectService? {
        val project = ProjectManager.getInstance().openProjects
            .find { it.basePath == directory }
            ?: return null
        return project.service<KiloBackendProjectService>()
    }

    // ------ mapping: domain model → DTO ------

    private fun dto(state: KiloProjectState): KiloProjectStateDto =
        when (state) {
            KiloProjectState.Pending -> KiloProjectStateDto(KiloProjectStatusDto.PENDING)
            is KiloProjectState.Loading -> KiloProjectStateDto(
                status = KiloProjectStatusDto.LOADING,
                progress = progress(state.progress),
            )
            is KiloProjectState.Ready -> KiloProjectStateDto(
                status = KiloProjectStatusDto.READY,
                providers = providers(state.providers),
                agents = agents(state.agents),
                commands = state.commands.map(::command),
                skills = state.skills.map(::skill),
            )
            is KiloProjectState.Error -> KiloProjectStateDto(
                status = KiloProjectStatusDto.ERROR,
                error = state.message,
            )
        }

    private fun progress(p: KiloProjectLoadProgress) = KiloProjectLoadProgressDto(
        providers = p.providers,
        agents = p.agents,
        commands = p.commands,
        skills = p.skills,
    )

    private fun providers(d: ProviderData) = ProvidersDto(
        providers = d.providers.map(::provider),
        connected = d.connected,
        defaults = d.defaults,
    )

    private fun provider(p: ProviderInfo) = ProviderDto(
        id = p.id,
        name = p.name,
        source = p.source,
        models = p.models.mapValues { (_, m) -> model(m) },
    )

    private fun model(m: ModelInfo) = ModelDto(
        id = m.id,
        name = m.name,
        attachment = m.attachment,
        reasoning = m.reasoning,
        temperature = m.temperature,
        toolCall = m.toolCall,
        free = m.free,
        status = m.status,
    )

    private fun agents(d: AgentData) = AgentsDto(
        agents = d.agents.map(::agent),
        all = d.all.map(::agent),
        default = d.default,
    )

    private fun agent(a: AgentInfo) = AgentDto(
        name = a.name,
        displayName = a.displayName,
        description = a.description,
        mode = a.mode,
        native = a.native,
        hidden = a.hidden,
        color = a.color,
        deprecated = a.deprecated,
    )

    private fun command(c: CommandInfo) = CommandDto(
        name = c.name,
        description = c.description,
        source = c.source,
        hints = c.hints,
    )

    private fun skill(s: SkillInfo) = SkillDto(
        name = s.name,
        description = s.description,
        location = s.location,
    )
}
