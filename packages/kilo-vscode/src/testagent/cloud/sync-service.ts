// testagent_change - new file: synchronize archive files through the cloud workspace API
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CoreArchiveApi, parseSessionArchive, type ArchiveContext, type SessionArchive } from "./archive-api"
import { listArchiveFiles } from "./archive-files"
import { WorkspaceSyncRegistry } from "./coordinator"
import { CloudGitError, inspectCloudGitRemotes } from "./git-preflight"
import { isMissingService, type RemoteSshApi } from "./ssh-api"
import {
  cloudPaths,
  ensureCloudWorkspace,
  readCloudInfo,
  resolveGitRoot,
  writeCloudInfo,
  type CloudWorkspace,
} from "./workspace"

export type CloudSyncMode = "local" | "cloud"

export type CloudSyncStage =
  | "workspace"
  | "scheduler"
  | "service_status"
  | "download"
  | "archive_scan"
  | "archive_read"
  | "preserve"
  | "cleanup"

export type CloudSyncIssue = {
  stage: CloudSyncStage
  serviceId?: string
  code: string
}

export type CloudArchiveSyncOptions = {
  mode: CloudSyncMode
  registry: WorkspaceSyncRegistry
  archive: CoreArchiveApi
  remote: () => Promise<RemoteSshApi>
  context?: (root: string) => ArchiveContext | Promise<ArchiveContext>
  intervalMs?: number
  heartbeatMs?: number
  leaseMs?: number
  onImported?: () => void
  onError: (issue: CloudSyncIssue, err?: unknown) => void
}

export class CloudArchiveSyncError extends Error {
  constructor(
    message: string,
    readonly stage: CloudSyncStage,
    readonly code: string,
    readonly serviceId?: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CloudArchiveSyncError"
  }
}

export class CloudArchiveSyncService {
  constructor(private readonly opts: CloudArchiveSyncOptions) {}

  async refresh(input: string): Promise<boolean> {
    const dir = await workspaceDirectory(input).catch((err) => {
      this.report("workspace", undefined, err)
      return undefined
    })
    if (!dir) return false

    const git = await inspectCloudGitRemotes(dir).catch((err: unknown) => {
      if (err instanceof CloudGitError && err.code !== "git_error") return undefined
      this.report("workspace", undefined, err)
      return undefined
    })
    if (!git) return false

    const paths = cloudPaths(git.root)
    if (
      this.opts.mode === "local" &&
      !(await exists(paths.info).catch((err) => {
        this.report("workspace", undefined, err)
        return false
      }))
    )
      return false

    if (this.opts.mode === "cloud") {
      const files = await listArchiveFiles(paths.import, git.root).catch((err) => {
        this.report("archive_scan", undefined, err)
        return undefined
      })
      if (!files || files.length === 0) return false
    }

    const workspace = await ensureCloudWorkspace(git.root).catch((err) => {
      this.report("workspace", undefined, err)
      return undefined
    })
    if (!workspace) return false
    if (this.opts.mode === "local" && workspace.state.serviceIds.length === 0) {
      await this.cleanup(workspace.root, workspace.import, []).catch((err) => this.report("cleanup", undefined, err))
      return false
    }

    const coord = await this.opts.registry
      .get(git.root, {
        intervalMs: this.opts.intervalMs,
        heartbeatMs: this.opts.heartbeatMs,
        leaseMs: this.opts.leaseMs,
        onError: (err) =>
          this.report(
            err instanceof CloudArchiveSyncError ? err.stage : "scheduler",
            err instanceof CloudArchiveSyncError ? err.serviceId : undefined,
            err,
          ),
      })
      .catch((err) => {
        this.report("workspace", undefined, err)
        return undefined
      })
    if (!coord) return false
    return coord.start(() => this.poll(workspace))
  }

  async dispose(): Promise<void> {
    await this.opts.registry.dispose()
  }

  private async poll(workspace: CloudWorkspace): Promise<void> {
    if (this.opts.mode === "cloud") {
      await this.import(workspace.root, workspace)
      return
    }
    await this.download(workspace)
  }

  private async download(workspace: CloudWorkspace): Promise<void> {
    workspace.state = await readCloudInfo(workspace.root).catch((err) => {
      throw new CloudArchiveSyncError("无法读取云端沙箱绑定状态", "workspace", errorCode(err), undefined, err)
    })
    if (workspace.state.serviceIds.length === 0) {
      await this.cleanup(workspace.root, workspace.import, workspace.state.serviceIds).catch((err) =>
        this.report("cleanup", undefined, err),
      )
      return
    }
    const api = await this.opts.remote().catch((err) => {
      throw new CloudArchiveSyncError(
        "无法连接工作台的 TSCode Remote 扩展",
        "service_status",
        errorCode(err),
        undefined,
        err,
      )
    })
    for (const id of workspace.state.serviceIds) {
      if (!safeName(id)) {
        this.report(
          "service_status",
          id,
          new CloudArchiveSyncError("云端沙箱 ID 不能用作云端会话目录名", "service_status", "invalid_service_id", id),
        )
        continue
      }
      await this.downloadOne(api, workspace, id).catch((err) => this.report("download", id, err))
    }
    await this.cleanup(workspace.root, workspace.import, workspace.state.serviceIds).catch((err) =>
      this.report("cleanup", undefined, err),
    )
  }

  private async downloadOne(api: RemoteSshApi, workspace: CloudWorkspace, id: string): Promise<void> {
    const state = await api.getContainer(id).catch(async (err) => {
      const code = errorCode(err)
      if (isMissingService(err)) {
        await this.unbind(workspace, id)
        return undefined
      }
      if (retryable(code)) {
        this.report(
          "service_status",
          id,
          new CloudArchiveSyncError("码云服务尚未就绪，将在后续同步周期重试", "service_status", code, id, err),
        )
        return undefined
      }
      throw new CloudArchiveSyncError("无法查询码云容器状态", "service_status", code, id, err)
    })
    if (!state) return
    if (state && state.service_id !== id) {
      throw new CloudArchiveSyncError(
        "码云服务状态返回的云端沙箱 ID 不一致",
        "service_status",
        "service_id_mismatch",
        id,
      )
    }
    if (state.status === "deleted" || state.status === "business_deleted") {
      await this.unbind(workspace, id)
      return
    }
    if (state.status !== "running") return
    if (state.service_id !== id || !safeName(state.gitee_repository)) {
      throw new CloudArchiveSyncError("码云容器返回的仓库信息无效", "service_status", "invalid_repository", id)
    }
    if (state.git_fin_status && state.git_fin_status !== "initialized") return

    const target = path.join(workspace.import, id)
    await fs.mkdir(target, { recursive: true }).catch((err) => {
      throw new CloudArchiveSyncError("无法在本地工作区码云仓库中创建云端会话目录", "download", "filesystem_error", id, err)
    })
    const source = `${id}:/app/${state.gitee_repository}/.testagent/cloud/export`
    const result = await api.syncFiles(source, target, "skip", false).catch((err) => {
      const code = errorCode(err)
      throw new CloudArchiveSyncError("云端会话下载失败", "download", code, id, err)
    })
    if (!result.complete && result.skipped === 0) {
      throw new CloudArchiveSyncError("云端会话未完整同步", "download", "sync_incomplete", id)
    }
  }

  private async cleanup(root: string, dir: string, ids: string[]): Promise<void> {
    const rel = path.relative(root, dir)
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return
    const parts = rel ? rel.split(path.sep) : []
    for (const item of [root, ...parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)))]) {
      const stat = await fs.lstat(item).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        throw err
      })
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return []
      throw err
    })
    const bound = new Set(ids)
    for (const entry of entries) {
      if (!entry.isDirectory() || bound.has(entry.name) || !safeName(entry.name)) continue
      const next = path.join(dir, entry.name)
      const stat = await fs.lstat(next).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        this.report("cleanup", entry.name, err)
        return undefined
      })
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue
      const files = await fs.readdir(next).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined
        this.report("cleanup", entry.name, err)
        return undefined
      })
      if (!files || files.length > 0) continue
      await fs.rmdir(next).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ENOTEMPTY" || err.code === "EEXIST") return
        this.report("cleanup", entry.name, err)
      })
    }
  }

  private async unbind(workspace: CloudWorkspace, id: string): Promise<void> {
    const state = await writeCloudInfo(workspace.root, {
      serviceIds: workspace.state.serviceIds.filter((serviceId) => serviceId !== id),
    }).catch((err) => {
      throw new CloudArchiveSyncError("无法清除已删除的云端沙箱绑定", "workspace", errorCode(err), id, err)
    })
    workspace.state.serviceIds = state.serviceIds
  }

  private async import(root: string, workspace: CloudWorkspace): Promise<void> {
    const files = await listArchiveFiles(workspace.import, root)
    const ctx = await Promise.resolve()
      .then(() => this.opts.context?.(root) ?? { directory: root })
      .catch((err) => {
        throw new CloudArchiveSyncError(
          "无法解析云端会话导入的工作区上下文",
          "workspace",
          errorCode(err),
          undefined,
          err,
        )
      })
    if ((await resolveGitRoot(ctx.directory)) !== root) {
      throw new CloudArchiveSyncError("云端会话的导入目标不属于当前本地工作区码云仓库", "preserve", "workspace_mismatch")
    }
    for (const file of files) {
      await this.preserve(file, ctx, root).catch((err) =>
        this.report(err instanceof CloudArchiveSyncError ? err.stage : "preserve", undefined, err),
      )
    }
  }

  private async preserve(file: string, ctx: ArchiveContext, root: string): Promise<void> {
    const raw = await fs.readFile(file, "utf8").catch((err) => {
      throw new CloudArchiveSyncError(
        "无法读取待导入的云端会话",
        "archive_read",
        errorCode(err),
        undefined,
        err,
      )
    })
    const archive = decodeArchive(raw)
    const rel = relative(archive.info.path)
    const copy: SessionArchive = {
      ...archive,
      info: { ...archive.info, directory: ctx.directory, path: rel, workspaceID: ctx.workspace },
    }
    await this.opts.archive.preserveArchive(copy, ctx).catch((err) => {
      throw new CloudArchiveSyncError("无法将云端会话导入本地", "preserve", errorCode(err), undefined, err)
    })
    await fs.rm(file).catch((err) => {
      throw new CloudArchiveSyncError(
        "云端会话已导入，但无法删除临时文件",
        "cleanup",
        errorCode(err),
        undefined,
        err,
      )
    })
    this.opts.onImported?.()
  }

  private report(stage: CloudSyncStage, serviceId: string | undefined, err: unknown): void {
    this.opts.onError({ stage, serviceId, code: errorCode(err) }, err)
  }
}

async function workspaceDirectory(input: string): Promise<string | undefined> {
  const stat = await fs.stat(input).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined
    throw new CloudArchiveSyncError("无法读取本地工作区码云仓库路径", "workspace", "filesystem_error", undefined, err)
  })
  if (!stat) return undefined
  return stat.isDirectory() ? input : path.dirname(input)
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false
      throw new CloudArchiveSyncError("无法检查 TSCode Remote 插件的状态文件", "workspace", "filesystem_error", undefined, err)
    },
  )
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new CloudArchiveSyncError("云端会话格式无效", "archive_read", "invalid_json", undefined, err)
  }
}

function decodeArchive(raw: string): SessionArchive {
  try {
    return parseSessionArchive(parseJson(raw))
  } catch (err) {
    if (err instanceof CloudArchiveSyncError) throw err
    throw new CloudArchiveSyncError("本地工作区码云仓库中的云端会话结构无效", "archive_read", errorCode(err), undefined, err)
  }
}

function relative(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value !== "string") throw new CloudArchiveSyncError("云端会话路径格式无效", "archive_read", "invalid_path")
  const slash = value.replace(/\\/g, "/")
  if (slash.includes("\0") || path.posix.isAbsolute(slash) || path.win32.isAbsolute(value)) {
    throw new CloudArchiveSyncError("云端会话路径必须是码云仓库内的相对路径", "archive_read", "invalid_path")
  }
  const norm = path.posix.normalize(slash)
  if (norm === ".." || norm.startsWith("../")) {
    throw new CloudArchiveSyncError("云端会话路径不能超出本地工作区码云仓库的工作树", "archive_read", "invalid_path")
  }
  return norm === "." ? "" : norm
}

function safeName(value: string): boolean {
  return !!value && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value)
}

function retryable(code: string): boolean {
  return code === "service_not_configured" || code === "service_not_running"
}

function errorCode(err: unknown): string {
  const data = record(err)
  if (typeof data?.code === "string") return data.code
  return err instanceof Error ? err.name : "unknown"
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
// testagent_change end
