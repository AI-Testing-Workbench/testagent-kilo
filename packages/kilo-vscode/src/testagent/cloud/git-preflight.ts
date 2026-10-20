// testagent_change - new file
import * as vscode from "vscode"
import simpleGit, { type SimpleGit } from "simple-git"
import { resolveGitRoot } from "./workspace"

export type GitRemote = {
  name: string
  owner: string
  repository: string
  transport: "http" | "https"
  prefix: string
  url: string
  direction: "fetch" | "push" | "fetch & push" // testagent_change
}

export type CloudGitItem = {
  label: string
  description?: string
  detail?: string
}

export type CloudGitQuickPickOptions = {
  ignoreFocusOut: true
  placeHolder: string
  matchOnDescription?: true
  matchOnDetail?: true
}

export type CloudGitUi = {
  pick: (items: readonly CloudGitItem[], opts: CloudGitQuickPickOptions) => PromiseLike<CloudGitItem | undefined>
  confirm: (message: string, accept: string, cancel: string) => PromiseLike<string | undefined>
  warn?: (message: string) => PromiseLike<boolean | undefined> // testagent_change
}

export type CloudGitQueue = {
  run: <T>(task: () => Promise<T>) => Promise<T>
}

export type CloudGitSelection = {
  root: string
  remote: GitRemote
  branch: string
  ignored: boolean
}

export type CloudGitWorkspace = { root: string; remotes: GitRemote[] }

export class CloudGitError extends Error {
  constructor(
    message: string,
    readonly code: "not_git" | "no_remote" | "unsupported_remote" | "no_branches" | "git_error",
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CloudGitError"
  }
}

const cancel = "取消，手动提交后继续"
const gitAccept = "仅使用已提交内容"

// testagent_change start - assign fetch/push direction after parsing and URL merging
export function parseGitRemote(value: string): Omit<GitRemote, "name" | "direction"> | undefined {
  // testagent_change end
  const url = parseUrl(value)
  if (!url || !["http:", "https:"].includes(url.protocol)) return undefined
  const repo = parseGitRepo(url.pathname)
  if (!repo) return undefined
  const prefix = `${url.protocol}//${url.host}`
  return {
    ...repo,
    transport: url.protocol === "http:" ? "http" : "https",
    prefix,
    url: `${prefix}/${repo.owner}/${repo.repository}`,
  }
}

export async function inspectCloudGitRemotes(dir: string): Promise<CloudGitWorkspace> {
  const root = await resolveGitRoot(dir)
  if (!root) throw new CloudGitError("当前工作区不是一个 Git 工作树", "not_git")
  return { root, remotes: await findGitRemotes(simpleGit(root)) }
}

// testagent_change - keep Git checks and modal prompts in the workspace operation queue
export async function selectCloudGitTarget(
  dir: string,
  queue: CloudGitQueue,
  ui: CloudGitUi = quickPickUi(),
): Promise<CloudGitSelection | undefined> {
  const root = await resolveGitRoot(dir)
  if (!root) throw new CloudGitError("当前工作区不是一个 Git 工作树", "not_git")
  return queue.run(() => selectGitRoot(root, ui))
}

// testagent_change - use when the caller already holds this workspace's coordinator queue
export async function selectCloudGitTargetInQueue(
  dir: string,
  ui: CloudGitUi = quickPickUi(),
): Promise<CloudGitSelection | undefined> {
  const root = await resolveGitRoot(dir)
  if (!root) throw new CloudGitError("当前工作区不是一个 Git 工作树", "not_git")
  return selectGitRoot(root, ui)
}

async function selectGitRoot(root: string, ui: CloudGitUi): Promise<CloudGitSelection | undefined> {
  const git = simpleGit(root)
  const remotes = await findGitRemotes(git)
  // testagent_change start - retain the configured push target when a single remote name needs no selection
  const remote =
    new Set(remotes.map((item) => item.name)).size === 1
      ? (remotes.find((item) => item.direction === "push") ??
        remotes.find((item) => item.direction === "fetch & push") ??
        remotes[0])
      : await chooseGitRemote(remotes, ui)
  // testagent_change end
  if (!remote) return undefined

  // testagent_change start - include submodule changes even when Git is configured to ignore them
  const status = await git.status(["--ignore-submodules=none"]).catch((err) => {
    throw new CloudGitError("无法检查本地工作区码云仓库的改动状态", "git_error", err)
  })
  const ignored = status.files.length > 0
  if (ignored) {
    const message = `本地 Git 工作区 (包括子仓库) 中有 ${status.files.length} 个未提交项（包括已暂存、未暂存或未跟踪的改动）。是否忽略这些本地改动，仅使用码云仓库中已提交版本在 云端沙箱 中继续？`
    if ((await ui.confirm(message, gitAccept, cancel)) !== gitAccept) return undefined
  }
  // testagent_change end

  const current = await git
    .raw(["branch", "--show-current"])
    .then((name) => name.trim())
    .catch(() => "")
  const remoteBranches = await listRemoteBranches(git, remote.name)
  const localBranches = await listLocalBranches(git, current)
  const branches = remoteBranches.length > 0 ? remoteBranches : localBranches
  if (branches.length === 0) throw new CloudGitError(`码云仓库 ${remote.name} 没有可选择的分支`, "no_branches")
  // testagent_change start - warn before showing branches if the current local branch is not tracked remotely
  if (current && !remoteBranches.includes(current) && ui.warn) {
    const message = `本地分支 ${current} 尚未推送至码云仓库的远端中。`
    if (!(await ui.warn(message))) return undefined
  }
  // testagent_change end

  const head = await git
    .raw(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote.name}/HEAD`])
    .then((name) => name.trim().slice(remote.name.length + 1))
    .catch(() => "")
  const preferred = branches.includes(current) ? current : branches.includes(head) ? head : branches[0]
  const ordered = [preferred!, ...branches.filter((branch) => branch !== preferred)]
  const branch = await chooseGitBranch(remote, ordered, preferred, ui)
  if (!branch) return undefined
  return { root, remote, branch, ignored }
}

async function listRemoteNames(git: SimpleGit): Promise<string[]> {
  const names = await git
    .raw(["remote"])
    .then((raw) => raw.split(/\r?\n/).filter(Boolean))
    .catch((err) => {
      throw new CloudGitError("无法读取本地工作区码云仓库的远程仓库列表", "git_error", err)
    })
  if (names.length === 0) throw new CloudGitError("当前本地工作区码云仓库未配置远程仓库", "no_remote")
  return names
}

// testagent_change start - represent each unique fetch/push URL while merging identical URLs
async function findGitRemotes(git: SimpleGit): Promise<GitRemote[]> {
  const names = await listRemoteNames(git)
  const items = await Promise.all(
    names.map(async (name) => {
      const [fetch, push] = await Promise.all([
        // testagent_change - only enumerate fetch URLs when a remote picker is needed
        names.length > 1
          ? git
              .raw(["remote", "get-url", "--all", name])
              .then((raw) =>
                raw
                  .split(/\r?\n/)
                  .map((url) => url.trim())
                  .filter(Boolean),
              )
              .catch(() => [])
          : Promise.resolve([]),
        git
          .raw(["remote", "get-url", "--push", "--all", name])
          .then((raw) =>
            raw
              .split(/\r?\n/)
              .map((url) => url.trim())
              .filter(Boolean),
          )
          .catch(() => []),
      ])
      const urls = new Map<
        string,
        { remote: Omit<GitRemote, "name" | "direction">; directions: Set<"fetch" | "push"> }
      >()
      for (const [values, direction] of [
        [fetch, "fetch"],
        [push, "push"],
      ] as const) {
        for (const value of values) {
          const parsed = parseGitRemote(value)
          if (!parsed) continue
          const item = urls.get(parsed.url)
          if (item) item.directions.add(direction)
          else urls.set(parsed.url, { remote: parsed, directions: new Set([direction]) })
        }
      }
      return [...urls].map(
        ([url, item]): GitRemote => ({
          name,
          ...item.remote,
          url,
          direction: item.directions.size === 2 ? "fetch & push" : item.directions.has("fetch") ? "fetch" : "push",
        }),
      )
    }),
  )
  const remotes = items.flat()
  if (remotes.length === 0) {
    throw new CloudGitError("目前仅支持 HTTP/HTTPS 远程地址配置的码云仓库", "unsupported_remote")
  }
  return remotes
}
// testagent_change end

function quickPickUi(): CloudGitUi {
  return {
    pick: (items, opts) => vscode.window.showQuickPick(items, opts),
    // testagent_change start - use the custom cancel action instead of the modal's default Cancel
    confirm: async (message, yes, no) => {
      const result = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        { title: yes },
        { title: no, isCloseAffordance: true },
      )
      return result?.title
    },
    // testagent_change end
    warn: async (message) =>
      (await vscode.window.showWarningMessage(message, { modal: true }, "继续")) === "继续", // testagent_change
  }
}

async function chooseGitRemote(remotes: GitRemote[], ui: CloudGitUi): Promise<GitRemote | undefined> {
  const items = remotes.map((remote) => ({
    label: remote.name,
    description: `(${remote.direction})`, // testagent_change
    detail: remote.url,
  }))
  const picked = await ui.pick(items, {
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: "请选择在 云端沙箱 中使用的码云仓库远端",
  })
  return remotes.find((remote) => remote.name === picked?.label && remote.url === picked.detail) // testagent_change
}

async function chooseGitBranch(
  remote: GitRemote,
  branches: string[],
  preferred: string | undefined,
  ui: CloudGitUi,
): Promise<string | undefined> {
  const items = branches.map((branch) => ({
    label: branch,
    description: branch === preferred ? "默认分支" : undefined,
    detail: `${remote.name}/${branch}`,
  }))
  const picked = await ui.pick(items, {
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: `请选择在 云端沙箱 中使用的码云仓库分支`,
  })
  return branches.find((branch) => branch === picked?.label)
}

async function listRemoteBranches(git: SimpleGit, remote: string): Promise<string[]> {
  const raw = await git.raw(["for-each-ref", "--format=%(refname:short)", "refs/remotes/"]).catch((err) => {
    throw new CloudGitError("无法读取码云仓库分支", "git_error", err)
  })
  const prefix = `${remote}/`
  return [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map((ref) => ref.trim())
        .filter((ref) => ref.startsWith(prefix))
        .map((ref) => ref.slice(prefix.length))
        .filter((branch) => branch && branch !== "HEAD"),
    ),
  ].sort((left, right) => left.localeCompare(right))
}

async function listLocalBranches(git: SimpleGit, current: string): Promise<string[]> {
  const raw = await git.raw(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).catch((err) => {
    throw new CloudGitError("无法读取本地工作区码云仓库的分支", "git_error", err)
  })
  return [...new Set([...raw.split(/\r?\n/).map((name) => name.trim()), current].filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  )
}

function parseGitRepo(value: string): { owner: string; repository: string } | undefined {
  const decoded = decode(value)
  if (decoded === undefined) return undefined
  const clean = decoded.replace(/^\/+|\/+$/g, "")
  const parts = clean.split("/")
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) return undefined
  const owner = parts[0]!
  const repository = parts[1]!.replace(/\.git$/i, "")
  if (!repository || repository === "." || repository === ".." || !/^[\w.-]+$/.test(repository)) return undefined
  if (!/^[\w.-]+$/.test(owner)) return undefined
  return { owner, repository }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
