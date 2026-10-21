// testagent_change - new file: validate the local repository before a fast-forward-only cloud import pull
import simpleGit from "simple-git"
import { parseGitRemote } from "./git-preflight"
import type { ContainerStatusResult } from "./ssh-api"

export async function pullImportedRepository(root: string, state: ContainerStatusResult): Promise<string | undefined> {
  const target = repository(state)
  const branch = state.gitee_branch?.trim()
  const git = simpleGit(root)
  const remote = target ? await fetchRemote(git, target.url) : undefined
  const current = await git.raw(["branch", "--show-current"]).then(
    (raw) => raw.trim(),
    () => "",
  )
  const issues = mismatch(state, target, remote, branch, current)
  if (issues.length) return `${issues.join("\n")}\n\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。`
  if (!remote || !branch) return "无法确认码云仓库目标。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。"
  return fastForward(git, remote.name, branch)
}

function repository(state: ContainerStatusResult) {
  const prefix = state.gitee_url?.replace(/\/+$/, "")
  if (!prefix || !state.gitee_user || !state.gitee_repository) return
  return parseGitRemote(`${prefix}/${state.gitee_user}/${state.gitee_repository}`)
}

function mismatch(
  state: ContainerStatusResult,
  target: ReturnType<typeof repository>,
  remote: { name: string } | undefined,
  branch: string | undefined,
  current: string,
): string[] {
  return [
    !target ? "云端沙箱未返回有效的码云仓库地址。" : undefined,
    target && !remote ? `本地工作区仓库的远程地址与云端沙箱 ID ${state.service_id} 配置的码云仓库地址不匹配。` : undefined,
    !branch ? "云端沙箱未返回有效的码云分支。" : undefined,
    branch && current !== branch ? `本地当前分支“${current || "(detached)"}”与码云分支“${branch}”不匹配。` : undefined,
  ].filter((item): item is string => !!item)
}

async function fetchRemote(git: ReturnType<typeof simpleGit>, target: string): Promise<{ name: string } | undefined> {
  const refs = await git.raw(["remote"]).then(
    (raw) =>
      raw
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean),
    () => [],
  )
  const urls = await Promise.all(
    refs.map(async (name) => ({
      name,
      urls: await git.raw(["config", "--get-all", `remote.${name}.url`]).then(
        (raw) =>
          raw
            .split(/\r?\n/)
            .map((url) => url.trim())
            .filter(Boolean),
        () => [],
      ),
    })),
  )
  return urls.find((item) => item.urls.some((url) => parseGitRemote(url)?.url.toLowerCase() === target.toLowerCase()))
}

async function fastForward(
  git: ReturnType<typeof simpleGit>,
  remote: string,
  branch: string,
): Promise<string | undefined> {
  const ref = await git.raw(["check-ref-format", "--branch", branch]).then(
    () => true,
    () => false,
  )
  if (!ref) return `码云分支“${branch}”无效。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。`

  const status = await git.status().catch(() => undefined)
  if (!status) return "无法检查本地 Git 工作区。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。"
  if (status.files.length) return "本地 Git 工作区存在未提交改动，无法安全快进。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。"

  const head = await git.revparse("HEAD").then(
    (raw) => raw.trim(),
    () => "",
  )
  if (!head) return "无法读取本地 Git 提交。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。"
  const fetched = await git.raw(["fetch", "--no-tags", remote, `refs/heads/${branch}`]).then(
    () =>
      git.revparse("FETCH_HEAD").then(
        (raw) => raw.trim(),
        () => "",
      ),
    () => "",
  )
  if (!fetched) return `无法获取码云分支“${branch}”。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。`
  if (head === fetched) return

  const base = await git.raw(["merge-base", head, fetched]).then(
    (raw) => raw.trim(),
    () => "",
  )
  if (!base || base !== head) return `本地分支无法快进到码云分支“${branch}”。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。`

  const check = await git.status().catch(() => undefined)
  if (!check || check.files.length) return "拉取期间本地 Git 工作区发生变化，已停止快进。会话已导入。"
  const branchNow = await git.raw(["branch", "--show-current"]).then(
    (raw) => raw.trim(),
    () => "",
  )
  const headNow = await git.revparse("HEAD").then(
    (raw) => raw.trim(),
    () => "",
  )
  if (branchNow !== branch || headNow !== head) return "拉取期间本地分支发生变化，已停止快进。会话已导入。"

  return git.raw(["merge", "--ff-only", fetched]).then(
    () => undefined,
    () => `无法快进到码云分支“${branch}”。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。`,
  )
}
// testagent_change end
