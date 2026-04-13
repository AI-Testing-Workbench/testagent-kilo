package ai.kilocode.rpc

import ai.kilocode.rpc.dto.KiloProjectStateDto
import com.intellij.platform.rpc.RemoteApiProviderService
import fleet.rpc.RemoteApi
import fleet.rpc.Rpc
import fleet.rpc.remoteApiDescriptor
import kotlinx.coroutines.flow.Flow

/**
 * Project-level RPC API exposed from backend to frontend.
 *
 * Operations are scoped to a specific project directory.
 * The CLI backend is app-scoped, but each call routes to the
 * correct [KiloBackendProjectService] by directory lookup.
 */
@Rpc
interface KiloProjectRpcApi : RemoteApi<Unit> {
    companion object {
        suspend fun getInstance(): KiloProjectRpcApi {
            return RemoteApiProviderService.resolve(remoteApiDescriptor<KiloProjectRpcApi>())
        }
    }

    /** Observe project state loading progress. */
    suspend fun state(directory: String): Flow<KiloProjectStateDto>

    /** Trigger a full reload of project data. */
    suspend fun reload(directory: String)
}
