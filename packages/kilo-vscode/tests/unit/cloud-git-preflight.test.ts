// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import {
  CloudGitError,
  parseGitRemote,
  selectCloudGitTarget,
  type CloudGitItem,
  type CloudGitQuickPickOptions,
  type CloudGitQueue,
  type CloudGitSelection,
  type CloudGitUi,
} from "../../src/testagent/cloud/git-preflight"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { readCloudInfo } from "../../src/testagent/cloud/workspace"

const roots: string[] = []
const regs: WorkspaceSyncRegistry[] = []
const direct: CloudGitQueue = { run: (task) => task() }

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-git-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  return root
}

async function remote(
  root: string,
  name: string,
  url: string,
  refs: string[] = ["main"],
  head = "main",
): Promise<void> {
  const git = simpleGit(root)
  await git.addRemote(name, url)
  const hash = await git.revparse("HEAD")
  await Promise.all(refs.map((branch) => git.raw(["update-ref", `refs/remotes/${name}/${branch}`, hash])))
  await git.raw(["symbolic-ref", "--quiet", `refs/remotes/${name}/HEAD`, `refs/remotes/${name}/${head}`])
}

function ui(
  picks: Array<string | undefined> = [],
  choice?: string,
): {
  ui: CloudGitUi
  state: { items: CloudGitItem[][]; opts: CloudGitQuickPickOptions[]; messages: string[]; modals: string[] }
} {
  const state = {
    items: [] as CloudGitItem[][],
    opts: [] as CloudGitQuickPickOptions[],
    messages: [] as string[],
    modals: [] as string[],
  }
  return {
    state,
    ui: {
      pick: async (items, opts) => {
        state.items.push([...items])
        state.opts.push(opts)
        const label = picks.shift()
        return items.find((item) => item.label === label)
      },
      confirm: async (message) => {
        state.messages.push(message)
        return choice
      },
      modal: async (message) => {
        state.modals.push(message)
      },
    },
  }
}

async function queue(root: string): Promise<Awaited<ReturnType<WorkspaceSyncRegistry["get"]>>> {
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  return reg.get(root, {
    onError: (err) => {
      throw err
    },
  })
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("Git remote 地址解析", () => {
  it("接受 HTTP(S) 地址并单独提供仓库路径与网址前缀", () => {
    expect(parseGitRemote("https://github.com/alice/repo.git")).toEqual({
      owner: "alice",
      repository: "repo",
      transport: "https",
      prefix: "https://github.com",
      url: "https://github.com/alice/repo",
    })
    expect(parseGitRemote("https://token:secret@github.com/alice/repo.git")).toMatchObject({
      prefix: "https://github.com",
      url: "https://github.com/alice/repo",
    })
    expect(parseGitRemote("http://github.com/alice/repo.git")).toMatchObject({
      owner: "alice",
      repository: "repo",
      transport: "http",
      prefix: "http://github.com",
    })
  })

  it("拒绝非 HTTP(S)、嵌套 namespace 和无法解析的 remote", () => {
    expect(parseGitRemote("not-a-url")).toBeUndefined()
    expect(parseGitRemote("file:///tmp/repo.git")).toBeUndefined()
    expect(parseGitRemote("git@github.com:alice/repo.git")).toBeUndefined()
    expect(parseGitRemote("ssh://git@github.com/alice/repo.git")).toBeUndefined()
    expect(parseGitRemote("git://github.com/alice/repo.git")).toBeUndefined()
    expect(parseGitRemote("https://gitlab.com/team/subgroup/repo.git")).toBeUndefined()
    expect(parseGitRemote("https://github.com/alice/%2e%2e.git")).toBeUndefined()
  })
})

describe("Git 仓库上云前置检查", () => {
  it("检查码云仓库工作树和 remote 配置，不限制托管平台", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-empty-"))
    roots.push(empty)
    await expect(selectCloudGitTarget(empty, direct, ui().ui)).rejects.toMatchObject<Partial<CloudGitError>>({
      code: "not_git",
    })
    expect(await fs.stat(path.join(empty, ".testagent")).catch(() => undefined)).toBeUndefined()

    const root = await repo()
    const coord = await queue(root)
    await expect(selectCloudGitTarget(root, coord, ui().ui)).rejects.toMatchObject<Partial<CloudGitError>>({
      code: "no_remote",
    })
    await remote(root, "origin", "https://github.com/alice/repo.git")
    const pick = ui(["main"])
    expect(await selectCloudGitTarget(root, coord, pick.ui)).toMatchObject({
      remote: {
        name: "origin",
        owner: "alice",
        repository: "repo",
        prefix: "https://github.com",
        url: "https://github.com/alice/repo",
      },
      branch: "main",
    })
    expect(await readCloudInfo(root)).toEqual({ serviceIds: [] })
  }, 30_000)

  it("从多个 HTTP(S) remote 中选择码云仓库目标并忽略 SSH remote", async () => {
    const root = await repo()
    await remote(root, "origin", "https://github.com/alice/repo.git", ["main"])
    await remote(root, "backup", "https://gitlab.com/alice/backup.git", ["main", "old"])
    await remote(root, "mirror", "https://codeberg.org/alice/mirror.git", ["main", "feature/work"])
    await remote(root, "ssh", "git@codeberg.org:alice/ssh.git")
    const coord = await queue(root)
    const pick = ui(["mirror", "feature/work"])
    const branch = await simpleGit(root).raw(["symbolic-ref", "--quiet", "--short", "HEAD"])

    const result: CloudGitSelection | undefined = await selectCloudGitTarget(root, coord, pick.ui)

    expect(result).toMatchObject({
      root,
      remote: {
        name: "mirror",
        owner: "alice",
        repository: "mirror",
        transport: "https",
        prefix: "https://codeberg.org",
      },
      branch: "feature/work",
      ignored: false,
    })
    expect(pick.state.items[0].map((item) => item.label)).toEqual(["backup", "mirror", "origin"])
    expect(pick.state.items[1].map((item) => item.label)).toEqual(["main", "feature/work"])
    expect(pick.state.opts).toHaveLength(2)
    expect(pick.state.opts.every((opts) => opts.ignoreFocusOut)).toBe(true)
    expect(pick.state.opts.every((opts) => opts.matchOnDetail)).toBe(true)
    expect(await simpleGit(root).raw(["symbolic-ref", "--quiet", "--short", "HEAD"])).toBe(branch)
    expect(await readCloudInfo(root)).toEqual({ serviceIds: [] })
  }, 15_000)

  it("默认选择当前分支，并在工作区有改动时先确认", async () => {
    const root = await repo()
    await remote(root, "fork", "https://github.com/alice/repo.git", ["main", "release/one"])
    const git = simpleGit(root)
    await fs.writeFile(path.join(root, "README.md"), "staged\n")
    await git.add("README.md")
    await fs.writeFile(path.join(root, "README.md"), "unstaged\n")
    await fs.writeFile(path.join(root, "untracked.txt"), "new\n")
    const coord = await queue(root)
    const pick = ui(["main"], "仅使用码云仓库已提交版本")

    const result = await selectCloudGitTarget(root, coord, pick.ui)

    expect(result).toMatchObject({ remote: { name: "fork" }, branch: "main", ignored: true })
    expect(pick.state.messages[0]).toContain("仅使用所选码云仓库的已提交版本")
    expect(pick.state.items[0][0].label).toBe("main")
    expect(pick.state.opts[0].ignoreFocusOut).toBe(true)
    expect(await readCloudInfo(root)).toEqual({ serviceIds: [] })
  }, 15_000)

  it("HEAD detached 时使用所选 remote 的默认分支", async () => {
    const root = await repo()
    const git = simpleGit(root)
    await remote(root, "mirror", "https://github.com/alice/repo.git", ["main", "release/one"], "release/one")
    await git.raw(["checkout", "--detach", "HEAD"])
    const coord = await queue(root)
    const pick = ui(["release/one"])

    const result = await selectCloudGitTarget(root, coord, pick.ui)

    expect(result?.branch).toBe("release/one")
    expect(pick.state.items[0][0].label).toBe("release/one")
    expect(await git.raw(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).toBe("")
  }, 15_000)

  it("当前分支不可用时使用 remote 默认分支", async () => {
    const root = await repo()
    const git = simpleGit(root)
    await remote(root, "fork", "https://github.com/alice/repo.git", ["release/one"], "release/one")
    const coord = await queue(root)
    const pick = ui(["release/one"])

    const result = await selectCloudGitTarget(root, coord, pick.ui)

    expect(result?.branch).toBe("release/one")
    expect(pick.state.items[0][0].label).toBe("release/one")
    expect((await git.raw(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim()).toBe("main")
  }, 15_000)

  it("取消选择 remote、脏工作区确认或分支时停止", async () => {
    const root = await repo()
    await remote(root, "one", "https://github.com/alice/one.git")
    await remote(root, "two", "https://gitlab.com/alice/two.git")
    const coord = await queue(root)

    const remoteCancel = ui([undefined])
    expect(await selectCloudGitTarget(root, coord, remoteCancel.ui)).toBeUndefined()

    await fs.writeFile(path.join(root, "untracked.txt"), "dirty\n")
    const dirtyCancel = ui(["one"], undefined)
    expect(await selectCloudGitTarget(root, coord, dirtyCancel.ui)).toBeUndefined()
    expect(dirtyCancel.state.messages).toHaveLength(1)

    await fs.rm(path.join(root, "untracked.txt"))
    const branchCancel = ui(["one", undefined])
    expect(await selectCloudGitTarget(root, coord, branchCancel.ui)).toBeUndefined()
    expect(await readCloudInfo(root)).toEqual({ serviceIds: [] })
  }, 15_000)

  it("remote 地址不可解析时拒绝选择", async () => {
    const root = await repo()
    await remote(root, "origin", "not-a-url")
    const coord = await queue(root)

    await expect(selectCloudGitTarget(root, coord, ui(["main"]).ui)).rejects.toMatchObject<Partial<CloudGitError>>({
      code: "unsupported_remote",
    })
  }, 15_000)

  it("fetch 地址与 push 地址不同时使用 push HTTP(S) 地址", async () => {
    const root = await repo()
    const git = simpleGit(root)
    await remote(root, "mirror", "https://github.com/alice/repo.git")
    await git.raw(["config", "--local", "remote.mirror.pushurl", "https://gitlab.com/alice/repo.git"])
    const coord = await queue(root)
    const pick = ui(["main"])

    const result = await selectCloudGitTarget(root, coord, pick.ui)

    expect(result?.remote).toMatchObject({
      name: "mirror",
      transport: "https",
      prefix: "https://gitlab.com",
      url: "https://gitlab.com/alice/repo",
    })
  }, 60_000)

  it("没有所选 remote 的分支时提示本地分支尚未推送且不列本地分支", async () => {
    const root = await repo()
    await simpleGit(root).addRemote("origin", "https://github.com/alice/repo.git")
    const coord = await queue(root)
    const pick = ui(["main"])

    expect(await selectCloudGitTarget(root, coord, pick.ui)).toBeUndefined()
    expect(pick.state.modals).toEqual([
      "所选码云仓库远端 origin 没有可选择的分支。本地分支 main 尚未推送至该远端。请先将分支推送至该远端后重试。",
    ])
    expect(pick.state.items).toHaveLength(0)
  }, 60_000)

  it("没有 HTTP(S) remote 时报告不支持的地址协议", async () => {
    const root = await repo()
    await simpleGit(root).addRemote("origin", "git@github.com:alice/repo.git")
    const coord = await queue(root)

    await expect(selectCloudGitTarget(root, coord, ui().ui)).rejects.toMatchObject<Partial<CloudGitError>>({
      code: "unsupported_remote",
    })
  }, 15_000)

  it("其他窗口持有 coordinator 锁时不显示 remote 选择器", async () => {
    const root = await repo()
    await remote(root, "mirror", "https://github.com/alice/repo.git")
    const one = await queue(root)
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const two = await reg.get(root, {
      onError: (err) => {
        throw err
      },
    })
    const pick = ui(["main"])

    expect(await one.start(async () => undefined)).toBe(true)
    await expect(selectCloudGitTarget(root, two, pick.ui)).rejects.toThrow(
      "另一个 TS Code 工作台窗口正在同步此码云仓库",
    )
    expect(pick.state.items).toHaveLength(0)
  }, 15_000)
})
