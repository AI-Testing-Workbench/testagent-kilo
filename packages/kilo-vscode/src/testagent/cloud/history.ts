// testagent_change - new file: route archive, fork, upload, and export through existing HTTP services
import { createCoreArchiveApi, type CoreArchiveConnection } from "./archive-api"
import { CloudArchiveFiles, type CloudArchiveList } from "./archive-files"
import type { CloudArchiveData } from "./archive-data"
import { WorkspaceSyncRegistry } from "./coordinator"
import type { CloudGitUi } from "./git-preflight"
import { isRemoteSshOutdated, loadRemoteSshApi, type RemoteSshApi } from "./ssh-api"
import { pullImportedRepository } from "./import-sync"
import { CloudUploadError, CloudUploadService } from "./upload"
import { resolveGitRoot } from "./workspace"

type CloudHistoryAction = {
  action: "upload" | "export"
  sessionID: string
  pending: boolean
  cancelled?: boolean
}

type CloudHistoryMessage =
  | { type: "cloudArchiveListLoaded"; archives: CloudArchiveList["archives"]; invalidCount: number }
  | { type: "cloudArchiveLoaded"; key: string; archive: CloudArchiveData }
  | { type: "cloudArchiveForked"; key: string; sourceSessionID: string; sessionID: string }
  | { type: "cloudArchiveOperationFailed"; operation: "list" | "read" | "fork"; key?: string }
  | {
      type: "cloudActionProgress"
      action: CloudHistoryAction["action"]
      sessionID: CloudHistoryAction["sessionID"]
      pending: CloudHistoryAction["pending"]
      cancelled?: CloudHistoryAction["cancelled"]
    }

export type CloudHistoryOptions = {
  connection: CoreArchiveConnection
  registry: WorkspaceSyncRegistry
  dir: () => string
  sessionDir: (id: string) => Promise<string | undefined>
  context: (dir: string) => { directory: string; workspace?: string }
  pluginId: string
  ui: CloudGitUi
  post: (message: CloudHistoryMessage) => void
  onError: (err: unknown) => void
  success?: (message: string) => void
  local?: boolean
  warning?: (message: string) => PromiseLike<unknown> | unknown
  remote?: () => Promise<RemoteSshApi>
  rename?: (id: string, title: string, dir: string) => Promise<void>
  progress?: <T>(task: (finish: () => void) => Promise<T>) => Promise<T>
}

export class CloudHistory {
  private readonly files: CloudArchiveFiles
  private readonly service: CloudUploadService
  private readonly remote: () => Promise<RemoteSshApi>
  private readonly pending = new Set<string>()
  private listCache:
    | { type: "cloudArchiveListLoaded"; archives: CloudArchiveList["archives"]; invalidCount: number }
    | undefined

  constructor(private readonly opts: CloudHistoryOptions) {
    this.remote = opts.remote ?? loadRemoteSshApi
    this.files = new CloudArchiveFiles({
      registry: opts.registry,
      archive: createCoreArchiveApi(opts.connection),
      context: opts.context,
      onError: opts.onError,
    })
    this.service = new CloudUploadService({
      connection: opts.connection,
      registry: opts.registry,
      remote: this.remote,
      pluginId: opts.pluginId,
      onError: opts.onError,
    })
  }

  async list() {
    try {
      const result = await this.files.list(this.opts.dir())
      this.listCache = {
        type: "cloudArchiveListLoaded",
        archives: result.archives,
        invalidCount: result.invalidCount,
      }
      if (result.invalidCount) this.opts.onError(new Error(`发现 ${result.invalidCount} 个无效的云端会话文件`))
      this.opts.post(this.listCache)
    } catch (err) {
      this.fail("list", undefined, err)
      throw err
    }
  }

  async read(key: string) {
    try {
      const archive = await this.files.read(this.opts.dir(), key)
      this.opts.post({ type: "cloudArchiveLoaded", key, archive })
    } catch (err) {
      this.fail("read", key, err)
      throw err
    }
  }

  async fork(key: string) {
    try {
      const dir = this.opts.dir()
      const data = await this.files.read(dir, key)
      const result = await this.files.fork(dir, key)
      if (this.opts.rename) {
        const name = data.info.title
        const title = `${name}（来自云端）`
        const ctx = this.opts.context(dir)
        await this.opts.rename(result.sessionID, title, ctx.directory).catch((err) => {
          this.opts.onError(err)
        })
      }
      await this.syncImportedRepository(dir, key)
      return result
    } catch (err) {
      this.fail("fork", key, err)
      throw err
    }
  }

  push() {
    if (this.listCache) this.opts.post(this.listCache)
  }

  async upload(id: string) {
    const key = `upload:${id}`
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.action({ action: "upload", sessionID: id, pending: true })
    const task = async (finish: () => void) => {
      try {
        const dir = await this.opts.sessionDir(id)
        if (!dir) {
          this.action({ action: "upload", sessionID: id, pending: false })
          this.opts.onError(new CloudUploadError("会话不属于当前本地工作区码云仓库", "session_mismatch"))
          return
        }
        const result = await this.service.upload(dir, id, dir, this.opts.ui, finish)
        this.action({
          action: "upload",
          sessionID: id,
          pending: false,
          cancelled: !result,
        })
        if (result) this.opts.success?.("本地会话已成功上传至云端沙箱")
      } catch (err) {
        this.opts.onError(err)
        this.action({ action: "upload", sessionID: id, pending: false })
      }
    }
    try {
      await (this.opts.progress ? this.opts.progress(task) : task(() => undefined))
    } finally {
      this.pending.delete(key)
    }
  }

  async export(id: string) {
    const dir = await this.opts.sessionDir(id).catch((err) => {
      this.opts.onError(err)
      return undefined
    })
    if (!dir) {
      this.opts.onError(new CloudUploadError("会话不属于当前本地工作区码云仓库", "session_mismatch"))
      return
    }
    const key = `export:${id}`
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.action({ action: "export", sessionID: id, pending: true })
    try {
      const saved = await this.files.export(dir, id, dir)
      this.opts.success?.(`云端会话已导出为 ${saved.name}`)
    } catch (err) {
      this.opts.onError(err)
    } finally {
      this.action({ action: "export", sessionID: id, pending: false })
      this.pending.delete(key)
    }
  }

  private action(input: CloudHistoryAction) {
    this.opts.post({ type: "cloudActionProgress", ...input })
  }

  private fail(operation: "list" | "read" | "fork", key: string | undefined, err: unknown) {
    this.opts.onError(err)
    this.opts.post({ type: "cloudArchiveOperationFailed", operation, key })
  }

  private async syncImportedRepository(dir: string, key: string): Promise<void> {
    if (this.opts.local === false) return
    const name = key.replace(/\\/g, "/")
    const id = name.includes("/") ? name.slice(0, name.indexOf("/")) : undefined
    if (!id) {
      if (this.opts.warning) {
        await Promise.resolve(
          this.opts.warning("无法从云端会话目录读取云端沙箱 ID。会话已导入，但未自动将码云仓库的更新拉取到本地工作区码云仓库。"),
        ).catch((err) => this.opts.onError(err))
      }
      return
    }
    const message = await this.opts.registry
      .get(dir, { onError: this.opts.onError })
      .then((coord) =>
        coord.run(async () => {
          const state = await (await this.remote()).getContainer(id)
          if (state.service_id !== id) return "码云服务返回的云端沙箱 ID 与云端会话目录不一致。会话已导入，但未将码云仓库的更新拉取到本地工作区码云仓库。"
          if (state.status === "deleted" || state.status === "business_deleted") {
            return `云端沙箱 ID ${id} 对应的服务已删除。会话已导入，但未将码云仓库的更新拉取到本地工作区码云仓库。`
          }
          const root = await resolveGitRoot(dir)
          if (!root) return "当前目录已不属于 Git 工作树。会话已导入，但未将码云仓库的更新拉取到本地工作区码云仓库。"
          return pullImportedRepository(root, state)
        }),
      )
      .catch((err) => {
        if (isRemoteSshOutdated(err)) return undefined
        return `无法校验云端沙箱 ID ${id} 对应的码云仓库信息。会话已导入，但未将码云仓库的更新拉取到本地工作区码云仓库。`
      })
    if (!message) return
    if (!this.opts.warning) {
      this.opts.onError(new Error(message))
      return
    }
    await Promise.resolve(this.opts.warning(message)).catch((err) => this.opts.onError(err))
  }
}
// testagent_change end
