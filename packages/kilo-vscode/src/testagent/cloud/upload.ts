// testagent_change - new file: upload committed-branch session archives via the public Remote SSH API
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { type CloudGitUi, CloudGitError, inspectCloudGitRemotes, selectCloudGitTargetInQueue } from "./git-preflight"
import { createCoreArchiveApi, exportSessionArchive, type CoreArchiveConnection } from "./archive-api"
import { CloudWorkspaceBusyError, WorkspaceSyncCoordinator, WorkspaceSyncRegistry } from "./coordinator"
import {
  type ContainerConfigEntry,
  type ContainerFileSyncResult,
  type RemoteSshApi,
  isMissingService,
  loadRemoteSshApi,
} from "./ssh-api"
import { ensureCloudWorkspace, resolveGitRoot, writeCloudInfo } from "./workspace"

export type CloudUploadReason =
  | "not_git"
  | "no_remote"
  | "unsupported_remote"
  | "no_branches"
  | "git_error"
  | "busy"
  | "session_mismatch"
  | "service_check_failed"
  | "pending"
/* Removed the sticky previous-failure state; retries are allowed
  | "service_unconfirmed"
*/

export type CloudUploadState = {
  root?: string
  enabled: boolean
  pending: boolean
  reason?: CloudUploadReason
}

export type CloudUploadResult = {
  serviceId: string
  status: string
  archiveName: string
}

export type CloudUploadOptions = {
  connection: CoreArchiveConnection
  registry: WorkspaceSyncRegistry
  remote?: () => Promise<RemoteSshApi>
  pluginId: string
  onError: (err: unknown) => void
}

export class CloudUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | CloudUploadReason
      | "sync_incomplete"
      | "prepared_missing"
      | "service_mismatch"
      | "service_check_failed"
      | "service_record_failed"
      | "archive_cleanup_failed"
      | "initialization_failed"
      | "callback_failed"
      | "remote_api_failed"
      | "remote_cleanup_failed",
    readonly serviceId?: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CloudUploadError"
  }
}

type Prepared = { container?: ContainerConfigEntry; sync?: ContainerFileSyncResult }

export class CloudUploadService {
  private readonly pending = new Set<string>()
  /* Previous failures no longer permanently block a repository.
  private readonly blocked = new Set<string>()
  */
  private readonly remote: () => Promise<RemoteSshApi>
  private readonly archive: ReturnType<typeof createCoreArchiveApi>

  constructor(private readonly opts: CloudUploadOptions) {
    this.remote = opts.remote ?? loadRemoteSshApi
    this.archive = createCoreArchiveApi(opts.connection)
  }

  async state(dir: string, sessionDir: string): Promise<CloudUploadState> {
    const root = await resolveGitRoot(dir)
    if (!root) return { enabled: false, pending: false, reason: "not_git" }
    const key = rootKey(root)
    if (this.pending.has(key)) return { root, enabled: false, pending: true, reason: "pending" }
    /* No sticky service-unconfirmed gate.
    if (this.blocked.has(key)) return { root, enabled: false, pending: false, reason: "service_unconfirmed" }
    */
    const coord = await this.opts.registry.get(root, { onError: this.opts.onError })
    try {
      return await coord.run(async () => {
        if (this.pending.has(key)) return { root, enabled: false, pending: true, reason: "pending" }
        /* Failed creates remain retryable.
        if (this.blocked.has(key)) return { root, enabled: false, pending: false, reason: "service_unconfirmed" }
        */
        if ((await resolveGitRoot(sessionDir)) !== root) {
          return { root, enabled: false, pending: false, reason: "session_mismatch" }
        }

        const found = await inspectCloudGitRemotes(root).catch((err: unknown) => {
          if (err instanceof CloudGitError) return { error: err }
          throw new CloudUploadError("无法检查本地工作区码云仓库状态", "git_error", undefined, err)
        })
        if ("error" in found) return { root, enabled: false, pending: false, reason: found.error.code }

        const workspace = await ensureCloudWorkspace(root)
        const serviceIds = workspace.state.serviceIds
        if (serviceIds.length) {
          const live: string[] = []
          for (const id of serviceIds) if (await this.live(id)) live.push(id)
          if (live.length !== serviceIds.length) {
            const info = await writeCloudInfo(root, { serviceIds: live })
            workspace.state.serviceIds = info.serviceIds
          }
        }
        return { root, enabled: found.remotes.length > 0, pending: false }
      })
    } catch (err) {
      if (err instanceof CloudWorkspaceBusyError) return { root, enabled: false, pending: true, reason: "busy" }
      throw err
    }
  }

  async upload(
    dir: string,
    sessionID: string,
    sessionDir: string,
    ui: CloudGitUi,
    start: () => void = () => undefined,
  ): Promise<CloudUploadResult | undefined> {
    const state = await this.state(dir, sessionDir)
    if (!state.root) throw new CloudUploadError("当前工作区不是一个码云仓库", "not_git")
    if (!state.enabled) {
      if (state.reason === "busy") {
        throw new CloudUploadError("另一个工作台窗口正在处理此本地工作区码云仓库，请稍后重试", "busy")
      }
      /* Prior failed operations no longer block retries.
      if (state.reason === "service_unconfirmed") {
        throw new CloudUploadError(
          "另一个工作台窗口尚未确认此本地工作区码云仓库的状态，已阻止重复创建",
          "service_unconfirmed",
        )
      }
      */
      if (state.reason === "pending") throw new CloudUploadError("此本地工作区码云仓库正在执行上云操作", "pending")
      throw new CloudUploadError("当前本地工作区码云仓库暂时无法上云", state.reason ?? "git_error")
    }

    const root = state.root
    const key = rootKey(root)
    if (this.pending.has(key)) throw new CloudUploadError("此本地工作区码云仓库正在执行上云操作", "pending")
    /* A failed create no longer creates a permanent block.
    if (this.blocked.has(key)) {
      throw new CloudUploadError("尚未确认此本地工作区码云仓库关联的云端服务状态，已阻止重复创建", "service_unconfirmed")
    }
    */
    this.pending.add(key)
    try {
      const coord = await this.opts.registry.get(root, { onError: this.opts.onError })
      return await coord.run(async () => {
        if ((await resolveGitRoot(sessionDir)) !== root) {
          throw new CloudUploadError("所选会话不属于当前本地工作区码云仓库", "session_mismatch")
        }
        await inspectCloudGitRemotes(root)

        const pick = await selectCloudGitTargetInQueue(root, ui)
        if (!pick) return undefined
        /* Preparation progress now begins at click and ends at createContainer.
        const prepare = this.opts.progress ?? ((task) => task())
        const { rem, saved } = await prepare(async () => {
          const rem = await this.remote()
          const saved = await exportSessionArchive(root, this.archive, sessionID, { directory: sessionDir })
          return { rem, saved }
        })
        */
        const rem = await this.remote()
        const saved = await exportSessionArchive(root, this.archive, sessionID, { directory: sessionDir })
        const prepared: Prepared = {}
        const req = {
          plugin_id: this.opts.pluginId,
          type: "testagent_cloud" as const,
          gitee_user: pick.remote.owner,
          gitee_repository: pick.remote.repository,
          gitee_branch: pick.branch,
          gitee_url: pick.remote.prefix,
          callbacks: {
            containerPrepared: async (container: ContainerConfigEntry) => {
              if (prepared.container) throw new CloudUploadError("码云服务重复触发了准备回调", "prepared_missing")
              if (!container.serviceId)
                throw new CloudUploadError("码云服务准备回调未提供云端沙箱 ID", "prepared_missing")
              prepared.container = container
              const target = `${container.serviceId}:/app/${pick.remote.repository}/.testagent/cloud/import/${saved.name}`
              const sync = await rem.syncFiles(saved.file, target, "overwrite", false, container)
              if (!sync.complete || sync.skipped > 0) {
                throw new CloudUploadError("无法将云端会话完整上传到码云仓库", "sync_incomplete", container.serviceId)
              }
              prepared.sync = sync
            },
          },
        }

        await rem.revealSidebar()
        start()
        const result = await rem.createContainer(req, { showNotifications: true }).catch(async (err: unknown) => {
          const failed = cleanupFailure(err)
          if (failed) {
            throw new CloudUploadError(
              "创建回调失败",
              "remote_cleanup_failed",
              failed,
              err,
            )
          }
          if (initializationFailure(err)) {
            throw new CloudUploadError(
              "云端沙箱初始化失败",
              "initialization_failed",
              undefined,
              err,
            )
          }
          const data = record(err)
          if (data?.code === "callback_failed") {
            throw new CloudUploadError(
              "码云仓库创建回调失败",
              "callback_failed",
              typeof data.serviceId === "string" ? data.serviceId : undefined,
              err,
            )
          }
          throw new CloudUploadError("创建云端沙箱失败", "remote_api_failed", undefined, err)
        })
        if (!result.service_id) {
          throw new CloudUploadError("码云服务未返回云端沙箱 ID", "prepared_missing")
        }
        if (!prepared.container || !prepared.sync) {
          throw new CloudUploadError(
            "码云服务未完成容器准备回调",
            "prepared_missing",
            result.service_id,
          )
        }
        if (prepared.container.serviceId !== result.service_id) {
          throw new CloudUploadError(
            "回调中的云端沙箱 ID 与创建响应不匹配",
            "service_mismatch",
            result.service_id,
          )
        }

        await this.remember(root, result.service_id, rem)
        await fs.rm(saved.file).catch((err) => {
          throw new CloudUploadError(
            "云端会话已上传并关联到云端服务，但本地会话文件清理失败",
            "archive_cleanup_failed",
            result.service_id,
            err,
          )
        })
        return { serviceId: result.service_id, status: result.status, archiveName: saved.name }
      })
    } finally {
      this.pending.delete(key)
    }
  }

  private async remember(root: string, id: string, remote: RemoteSshApi): Promise<void> {
    try {
      const workspace = await ensureCloudWorkspace(root)
      await writeCloudInfo(root, { serviceIds: [...workspace.state.serviceIds, id] })
    } catch (err) {
      try {
        await remote.deleteContainer(id)
      } catch (cleanup) {
        throw new CloudUploadError(
          "无法保存云端沙箱 ID，且远程清理失败",
          "remote_cleanup_failed",
          id,
          cleanup,
        )
      }
      throw new CloudUploadError(
        "无法保存云端沙箱 ID",
        "service_record_failed",
        id,
        err,
      )
    }
  }

  private async live(id: string): Promise<boolean> {
    const api = await this.remote()
    const state = await api.getContainer(id).catch((err) => {
      if (isMissingService(err)) return undefined
      throw new CloudUploadError("无法确认已绑定的云端沙箱状态", "service_check_failed", id, err)
    })
    if (!state) return false
    if (state.service_id !== id) {
      throw new CloudUploadError("码云服务状态返回的云端沙箱 ID 不一致", "service_check_failed", id)
    }
    return state.status !== "deleted" && state.status !== "business_deleted"
  }

  /* Removed: permanent in-memory blocking and retained lease after failures.
  private async block(key: string, coord: WorkspaceSyncCoordinator): Promise<void> {
    this.blocked.add(key)
    if (!(await coord.retain())) throw new CloudUploadError("无法保留本地工作区码云仓库的租约", "service_unconfirmed")
  }
  */
}

function cleanupFailure(err: unknown): string | undefined {
  const data = record(err)
  if (data?.code !== "callback_failed" || typeof data.serviceId !== "string") return undefined
  if (!("cleanupError" in data) || data.cleanupError === undefined || data.cleanupError === null) return undefined
  return data.serviceId
}

function initializationFailure(err: unknown): boolean {
  const data = record(err)
  return data?.name === "ContainerInitializationError" || data?.code === "creation_cancelled"
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function rootKey(root: string): string {
  return process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)
}
// testagent_change end
