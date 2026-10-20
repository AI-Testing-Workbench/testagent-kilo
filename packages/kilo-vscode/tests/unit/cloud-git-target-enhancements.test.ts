// testagent_change - new file: cover fetch/push targets, branch warnings, cloud export validation, and submodules
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudHistory } from "../../src/testagent/cloud/history"
import {
  selectCloudGitTarget,
  type CloudGitItem,
  type CloudGitQueue,
  type CloudGitUi,
} from "../../src/testagent/cloud/git-preflight"

const roots: string[] = []
const regs: WorkspaceSyncRegistry[] = []
const direct: CloudGitQueue = { run: (task) => task() }

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-target-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  return { root, git }
}

async function remote(root: string, name: string, url: string, refs = ["main"], head = "main") {
  const git = simpleGit(root)
  await git.addRemote(name, url)
  const hash = await git.revparse("HEAD")
  await Promise.all(refs.map((branch) => git.raw(["update-ref", `refs/remotes/${name}/${branch}`, hash])))
  await git.raw(["symbolic-ref", "--quiet", `refs/remotes/${name}/HEAD`, `refs/remotes/${name}/${head}`])
}

function ui(picks: string[], dirty = false) {
  const queue = [...picks]
  const state = {
    items: [] as CloudGitItem[][],
    confirms: [] as string[],
    warnings: [] as string[],
    events: [] as string[],
  }
  const view: CloudGitUi = {
    pick: async (items) => {
      state.events.push("pick")
      state.items.push([...items])
      const target = queue.shift()
      return items.find((item) => item.detail === target) ?? items.find((item) => item.label === target)
    },
    confirm: async (message, accept) => {
      state.events.push("confirm")
      state.confirms.push(message)
      return dirty ? accept : undefined
    },
    warn: async (message) => {
      state.events.push("warn")
      state.warnings.push(message)
      return true
    },
  }
  return { state, view }
}

describe("Cloud Git target enhancements", () => {
  it("lists unique fetch and push URLs with their direction and selects the chosen URL", async () => {
    const { root, git } = await repo()
    const fetch = "https://github.com/alice/fetch.git"
    await remote(root, "origin", fetch)
    await remote(root, "backup", "https://gitlab.com/alice/backup.git")
    await git.raw(["config", "--add", "remote.origin.url", "https://gitlab.com/alice/also.git"])
    await git.raw(["config", "--add", "remote.origin.pushurl", fetch])
    await git.raw(["config", "--add", "remote.origin.pushurl", "https://codeberg.org/alice/push.git"])
    const pick = ui(["https://codeberg.org/alice/push", "origin/main"])

    const result = await selectCloudGitTarget(root, direct, pick.view)

    expect(pick.state.items[0].map((item) => [item.label, item.description, item.detail])).toEqual([
      ["backup", "(fetch & push)", "https://gitlab.com/alice/backup"],
      ["origin", "(fetch & push)", "https://github.com/alice/fetch"],
      ["origin", "(fetch)", "https://gitlab.com/alice/also"],
      ["origin", "(push)", "https://codeberg.org/alice/push"],
    ])
    expect(result?.remote).toMatchObject({ name: "origin", url: "https://codeberg.org/alice/push", direction: "push" })
  }, 60_000)

  it("warns before branch selection when the local branch is not in remote tracking refs", async () => {
    const { root } = await repo()
    await remote(root, "origin", "https://github.com/alice/repo.git", ["release"], "release")
    const pick = ui(["origin/release"])

    const result = await selectCloudGitTarget(root, direct, pick.view)

    expect(pick.state.warnings[0]).toContain("本地分支 main")
    expect(pick.state.events).toEqual(["warn", "pick"])
    expect(result?.branch).toBe("release")
  }, 60_000)

  it("checks cloud-mode export against the current repository before calling the core API", async () => {
    const { root } = await repo()
    const session = await repo()
    await remote(session.root, "origin", "https://github.com/alice/session.git")
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const errors: unknown[] = []
    const calls: string[] = []
    const history = new CloudHistory({
      connection: {
        getClientAsync: async () => {
          calls.push("export")
          throw new Error("Cloud export API should not run for an unsupported workspace")
        },
        getServerConfig: () => ({ baseUrl: "http://127.0.0.1:1", password: "test" }),
      },
      registry: reg,
      dir: () => root,
      sessionDir: async () => session.root,
      context: (directory) => ({ directory }),
      pluginId: "test-tech.TestAgent",
      ui: ui([]).view,
      post: () => undefined,
      onError: (err) => errors.push(err),
      local: false,
    })

    await history.export("ses_cloud")

    expect(errors[0]).toMatchObject({ code: "workspace_error", detail: { code: "no_remote" } })
    expect(calls).toEqual([])
  }, 30_000)

  it("hides submodule remotes and branches but includes dirty submodule state", async () => {
    const nested = await repo()
    await nested.git.raw(["branch", "nested-only"])
    const { root, git } = await repo()
    const dir = path.join(root, "modules", "nested")
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await git.raw(["clone", nested.root, dir])
    const hash = await simpleGit(dir).revparse("HEAD")
    await fs.writeFile(
      path.join(root, ".gitmodules"),
      '[submodule "modules/nested"]\n\tpath = modules/nested\n\turl = https://gitlab.com/alice/nested.git\n\tignore = all\n',
    )
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${hash},modules/nested`])
    await git.add(".gitmodules")
    await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add submodule"])
    await git.addRemote("origin", "https://github.com/alice/parent.git")
    await git.addRemote("backup", "https://gitlab.com/alice/backup.git")
    await git.raw(["config", "--local", "submodule.modules/nested.ignore", "all"])
    await fs.writeFile(path.join(root, "modules", "nested", "README.md"), "modified\n")
    await fs.writeFile(path.join(root, "modules", "nested", "untracked.txt"), "untracked\n")
    const pick = ui(["https://github.com/alice/parent", "origin/main"], true)

    const result = await selectCloudGitTarget(root, direct, pick.view)

    expect(result?.ignored).toBe(true)
    expect(pick.state.confirms[0]).toContain("子仓库")
    expect(pick.state.items[0].map((item) => item.label)).toEqual(["backup", "origin"])
    expect(pick.state.items[1].map((item) => item.label)).toEqual(["main"])
  }, 60_000)
})
