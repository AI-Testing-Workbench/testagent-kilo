// testagent_change - new file: list, read, fork, and export local archives without path traversal
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CoreArchiveApi, exportSessionArchive, parseSessionArchive, type ArchiveContext } from "./archive-api"
import { cloudArchiveData, type CloudArchiveData, type CloudArchiveSummary } from "./archive-data"
import { WorkspaceSyncRegistry } from "./coordinator"
import { CloudGitError, inspectCloudGitRemotes } from "./git-preflight"
import { CloudWorkspaceError, ensureCloudWorkspace, resolveGitRoot } from "./workspace"

export type CloudArchiveList = { archives: CloudArchiveSummary[]; invalidCount: number }

export class CloudArchiveFilesError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_path" | "invalid_archive" | "not_found" | "busy" | "workspace_error",
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CloudArchiveFilesError"
  }
}

export type CloudArchiveFilesOptions = {
  registry: WorkspaceSyncRegistry
  archive: CoreArchiveApi
  onError: (err: unknown) => void
  context?: (dir: string) => ArchiveContext | Promise<ArchiveContext>
}

export class CloudArchiveFiles {
  private readonly pending = new Set<string>()

  constructor(private readonly opts: CloudArchiveFilesOptions) {}

  async list(dir: string): Promise<CloudArchiveList> {
    const workspace = await this.workspace(dir)
    return workspace.coord.run(async () => {
      // testagent_change start - archive scans must validate ancestor directories and stay in the repository
      const files = await listArchiveFiles(workspace.cloud.import, workspace.root)
      // testagent_change end
      const rows = await Promise.all(
        files.map(async (file) => {
          try {
            return summary(
              workspace.cloud.import,
              file,
              await readArchive(workspace.root, workspace.cloud.import, file),
            )
          } catch (err) {
            if (err instanceof CloudArchiveFilesError) return undefined
            throw err
          }
        }),
      )
      const archives = rows
        .filter((item): item is CloudArchiveSummary => item !== undefined)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionID.localeCompare(right.sessionID))
      return { archives, invalidCount: files.length - archives.length }
    })
  }

  async read(dir: string, key: string): Promise<CloudArchiveData> {
    const workspace = await this.workspace(dir)
    // testagent_change start - reject symlinked parents before reading archive data
    return workspace.coord.run(() =>
      readArchive(workspace.root, workspace.cloud.import, resolveArchivePath(workspace.cloud.import, key)),
    )
    // testagent_change end
  }

  async fork(dir: string, key: string): Promise<{ sourceSessionID: string; sessionID: string; forked: boolean }> {
    const workspace = await this.workspace(dir)
    const name = `${workspace.root}\0${key}`
    if (this.pending.has(name)) throw new CloudArchiveFilesError("此云端会话正在迁移中", "busy")
    this.pending.add(name)
    try {
      return await workspace.coord.run(async () => {
        // testagent_change start - fork only an archive whose full directory chain is safe
        const data = await readArchive(
          workspace.root,
          workspace.cloud.import,
          resolveArchivePath(workspace.cloud.import, key),
        )
        // testagent_change end
        const ctx = await this.context(workspace.root)
        return this.opts.archive.forkArchive(
          data as unknown as Awaited<ReturnType<CoreArchiveApi["exportArchive"]>>,
          ctx,
        )
      })
    } finally {
      this.pending.delete(name)
    }
  }

  async export(dir: string, sessionID: string, sessionDir: string): Promise<{ name: string }> {
    const workspace = await this.workspace(dir)
    return workspace.coord.run(async () => {
      if ((await resolveGitRoot(sessionDir)) !== workspace.root) {
        throw new CloudArchiveFilesError("云端会话不属于当前工作区码云仓库", "invalid_path")
      }
      const ctx = await this.context(sessionDir)
      const saved = await exportSessionArchive(workspace.root, this.opts.archive, sessionID, ctx)
      return { name: saved.name }
    })
  }

  private async workspace(dir: string) {
    const git = await inspectCloudGitRemotes(dir).catch((err) => {
      if (err instanceof CloudGitError) {
        throw new CloudArchiveFilesError(
          err.code === "unsupported_remote" ? err.message : "当前工作区不是一个合法的码云仓库",
          "workspace_error",
          err,
        )
      }
      throw err
    })
    const cloud = await ensureCloudWorkspace(git.root).catch((err) => {
      if (err instanceof CloudWorkspaceError) {
        throw new CloudArchiveFilesError(err.message, "workspace_error", err)
      }
      throw err
    })
    return {
      root: git.root,
      cloud,
      coord: await this.opts.registry.get(git.root, { onError: this.opts.onError }),
    }
  }

  private async context(dir: string): Promise<ArchiveContext> {
    const ctx = this.opts.context ? await this.opts.context(dir) : { directory: dir }
    if (!ctx.directory || (await resolveGitRoot(ctx.directory)) !== (await resolveGitRoot(dir))) {
      throw new CloudArchiveFilesError("云端会话中的工作区不属于当前工作区码云仓库", "invalid_path")
    }
    return ctx
  }
}

// testagent_change start - skip symlinks and constrain recursive scans to the repository
export async function listArchiveFiles(dir: string, root = dir): Promise<string[]> {
  await safeDir(root, dir).catch((err) => {
    if (err instanceof CloudArchiveFilesError && err.code === "not_found") return
    throw err
  })
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return []
    throw new CloudArchiveFilesError("无法读取云端会话中的目录", "invalid_path", err)
  })
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return []
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return listArchiveFiles(file, root)
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) return [file]
      return []
    }),
  )
  return files.flat().sort()
}
// testagent_change end

export function resolveArchivePath(dir: string, key: string): string {
  const name = key.replace(/\\/g, "/")
  if (
    !name ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    path.win32.isAbsolute(key) ||
    name.split("/").some((part) => !part || part === "." || part === "..") ||
    !name.toLowerCase().endsWith(".json")
  ) {
    throw new CloudArchiveFilesError("云端会话中的路径无效", "invalid_path")
  }
  const file = path.resolve(dir, ...name.split("/"))
  const rel = path.relative(dir, file)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new CloudArchiveFilesError("云端会话中的路径超出了本地工作区码云仓库的目录", "invalid_path")
  }
  return file
}

// testagent_change start - reject symlinked ancestors before reading archive content
async function readArchive(root: string, dir: string, file: string): Promise<CloudArchiveData> {
  await safeDir(root, path.dirname(file))
  const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
    throw new CloudArchiveFilesError("无法读取云端会话文件", "not_found", err)
  })
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CloudArchiveFilesError("云端会话中的路径指向的不是普通文件", "invalid_path")
  }
  const raw = await fs.readFile(file, "utf8").catch((err) => {
    throw new CloudArchiveFilesError("无法读取云端会话文件", "not_found", err)
  })
  if (!raw.trim()) throw new CloudArchiveFilesError("云端会话文件为空", "invalid_archive")
  const value = parse(raw)
  try {
    return cloudArchiveData(parseSessionArchive(value))
  } catch (err) {
    throw new CloudArchiveFilesError("云端会话内容无效", "invalid_archive", err)
  }
}
// testagent_change end

// testagent_change start - validate every directory component without following symlinks
async function safeDir(root: string, dir: string): Promise<void> {
  const rel = path.relative(root, dir)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new CloudArchiveFilesError("云端会话目录超出了本地工作区码云仓库的根目录", "invalid_path")
  }
  const dirs = rel ? rel.split(path.sep) : []
  const paths = dirs.map((_, i) => path.join(root, ...dirs.slice(0, i + 1)))
  for (const item of [root, ...paths]) {
    const stat = await fs.lstat(item).catch((err: NodeJS.ErrnoException) => {
      throw new CloudArchiveFilesError("无法读取云端会话目录", "not_found", err)
    })
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CloudArchiveFilesError("云端会话中的目录不能包含符号链接", "invalid_path")
    }
  }
}
// testagent_change end

function summary(dir: string, file: string, data: CloudArchiveData): CloudArchiveSummary {
  const key = path.relative(dir, file).split(path.sep).join("/")
  return {
    key,
    sessionID: data.info.id,
    title: data.info.title || "未命名会话",
    createdAt: data.info.time.created,
    updatedAt: data.info.time.updated,
    serviceId: key.includes("/") ? key.slice(0, key.indexOf("/")) : undefined,
  }
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new CloudArchiveFilesError("云端会话格式无效", "invalid_archive", err)
  }
}
