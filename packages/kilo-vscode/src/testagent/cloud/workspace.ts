// testagent_change - new file
import * as fs from "node:fs/promises"
import * as path from "node:path"
import simpleGit from "simple-git"
import { createAtomic, writeAtomic } from "./atomic"

export type CloudInfo = { serviceIds: string[] }

export type CloudPaths = {
  root: string
  cloud: string
  import: string
  export: string
  info: string
  lock: string
}

export type CloudWorkspace = CloudPaths & { state: CloudInfo }

export class CloudWorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: "not_git" | "invalid_info" | "invalid_ignore" | "multiple_services" | "filesystem_error",
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CloudWorkspaceError"
  }
}

export async function resolveGitRoot(dir: string): Promise<string | undefined> {
  const top = await simpleGit(dir)
    .revparse(["--show-toplevel"])
    .then((value) => value.trim())
    .catch(() => "")
  if (!top) return undefined
  return fs.realpath(top).catch(() => undefined)
}

export function cloudPaths(root: string): CloudPaths {
  const cloud = path.join(root, ".testagent", "cloud")
  return {
    root,
    cloud,
    import: path.join(cloud, "import"),
    export: path.join(cloud, "export"),
    info: path.join(cloud, "info.json"),
    lock: path.join(cloud, "sync.lock"),
  }
}

export async function ensureCloudWorkspace(dir: string): Promise<CloudWorkspace> {
  const root = await resolveGitRoot(dir)
  if (!root) {
    throw new CloudWorkspaceError("云端同步需要在本地工作区码云仓库的 Git 工作树中执行", "not_git")
  }

  const paths = cloudPaths(root)
  await Promise.all([fs.mkdir(paths.import, { recursive: true }), fs.mkdir(paths.export, { recursive: true })]).catch(
    (err) => {
      throw new CloudWorkspaceError("无法在本地工作区码云仓库中创建云端目录", "filesystem_error", err)
    },
  )
  await ensureIgnore(paths.cloud)
  const state = await readInfo(paths.info)
  return { ...paths, state }
}

export async function readCloudInfo(dir: string): Promise<CloudInfo> {
  return (await ensureCloudWorkspace(dir)).state
}

// testagent_change - binding updates must be called inside WorkspaceSyncCoordinator.run
export async function writeCloudInfo(dir: string, value: unknown): Promise<CloudInfo> {
  const workspace = await ensureCloudWorkspace(dir)
  const info = validateInfo(value)
  const file = workspace.info
  await fs.mkdir(path.dirname(file), { recursive: true }).catch((err) => {
    throw new CloudWorkspaceError("无法在本地工作区码云仓库中创建状态目录", "filesystem_error", err)
  })
  await writeAtomic(file, JSON.stringify(info, null, 2) + "\n")
  return info
}

async function ensureIgnore(dir: string): Promise<void> {
  const file = path.join(dir, ".gitignore")
  await fs.mkdir(dir, { recursive: true }).catch((err) => {
    throw new CloudWorkspaceError("无法在本地工作区码云仓库中创建临时目录", "filesystem_error", err)
  })
  const created = await fs.writeFile(file, "*\n", { flag: "wx" }).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return false
      throw new CloudWorkspaceError("无法在本地工作区码云仓库中创建 .gitignore", "filesystem_error", err)
    },
  )
  if (created) return
  const raw = await fs.readFile(file, "utf8").catch((err) => {
    throw new CloudWorkspaceError("无法读取本地工作区码云仓库中的 .gitignore", "filesystem_error", err)
  })
  if (raw.trim() !== "*") {
    throw new CloudWorkspaceError("本地工作区码云仓库中的 .gitignore 只能包含 *", "invalid_ignore")
  }
}

async function readInfo(file: string): Promise<CloudInfo> {
  const raw = await fs.readFile(file, "utf8").catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") {
      throw new CloudWorkspaceError("无法读取本地工作区码云仓库中的 info.json", "filesystem_error", err)
    }
    await writeInitial(file)
    return fs.readFile(file, "utf8").catch((read) => {
      throw new CloudWorkspaceError("无法读取本地工作区码云仓库中的 info.json", "filesystem_error", read)
    })
  })

  const value = parseJson(raw)
  if (!value.ok) throw new CloudWorkspaceError("本地工作区码云仓库中的 info.json 不是有效的 JSON", "invalid_info")
  return validateInfo(value.value)
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

function validateInfo(value: unknown): CloudInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudWorkspaceError("本地工作区码云仓库中的 info.json 必须是对象", "invalid_info")
  }
  const info = value as Record<string, unknown>
  if (Object.keys(info).length !== 1 || !Array.isArray(info.serviceIds)) {
    throw new CloudWorkspaceError("本地工作区码云仓库中的 info.json 只能包含 serviceIds 数组", "invalid_info")
  }
  if (info.serviceIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new CloudWorkspaceError("serviceIds 只能包含非空字符串", "invalid_info")
  }

  const ids = [...new Set(info.serviceIds)] as string[]
  if (ids.length > 1) {
    throw new CloudWorkspaceError("一个本地工作区码云仓库最多只能关联一个云端服务", "multiple_services")
  }
  return { serviceIds: ids }
}

async function writeInitial(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch((err) => {
    throw new CloudWorkspaceError("无法在本地工作区码云仓库中创建状态目录", "filesystem_error", err)
  })
  await createAtomic(file, JSON.stringify({ serviceIds: [] }, null, 2) + "\n")
}
