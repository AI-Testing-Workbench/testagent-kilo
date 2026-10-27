// testagent_change - new file: verify cloud exports require a matching clean Git branch
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudHistory } from "../../src/testagent/cloud/history"

const roots: string[] = []
const hosts: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []
const target = process.env.TESTAGENT_CLOUD_GITEE_BRANCH

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  if (target === undefined) delete process.env.TESTAGENT_CLOUD_GITEE_BRANCH
  else process.env.TESTAGENT_CLOUD_GITEE_BRANCH = target
})

async function setup(opts: { tracking?: string; branch?: string; answers?: Array<string | undefined> } = {}) {
  const tracking = opts.tracking ?? "origin/main"
  const branch = opts.branch ?? "main"
  const answers = opts.answers ?? []
  process.env.TESTAGENT_CLOUD_GITEE_BRANCH = branch
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-export-preflight-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://gitee.com/alice/repo.git")
  const head = await git.revparse("HEAD")
  await git.raw(["update-ref", "refs/remotes/origin/main", head])
  await git.raw(["update-ref", "refs/remotes/origin/release", head])
  if (tracking) await git.raw(["branch", "--set-upstream-to", tracking])

  const calls: string[] = []
  const host = Bun.serve({
    port: 0,
    fetch: () => {
      calls.push("export")
      return Response.json({ info: { id: "ses_export" }, messages: [] })
    },
  })
  hosts.push(host)
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const modals: string[] = []
  const prompts: string[] = []
  const errors: unknown[] = []
  const history = new CloudHistory({
    connection: {
      getClientAsync: async () => undefined,
      getServerConfig: () => ({ baseUrl: host.url.origin, password: "test" }),
    },
    registry: reg,
    dir: () => root,
    sessionDir: async () => root,
    context: (directory) => ({ directory }),
    pluginId: "test-tech.TestAgent",
    ui: {
      pick: async (items) => items[0],
      confirm: async (message) => {
        prompts.push(message)
        return answers.shift()
      },
      modal: async (message) => {
        modals.push(message)
      },
    },
    post: () => undefined,
    onError: (err) => errors.push(err),
    local: false,
  })
  return { root, git, history, calls, modals, prompts, errors }
}

it("stops exporting when the current branch does not match its tracked branch", async () => {
  const svc = await setup({ tracking: "origin/release" })

  await svc.history.export("ses_export")

  expect(svc.modals[0]).toContain("云端配置的码云分支 main 不一致，或追踪分支 origin/release 尚未同步")
  expect(svc.calls).toEqual([])
  expect(svc.errors).toEqual([])
}, 30_000)

it("stops exporting when the current branch differs from the cloud-configured branch", async () => {
  const svc = await setup({ branch: "release" })

  await svc.history.export("ses_export")

  expect(svc.modals[0]).toContain("当前分支 main 与云端配置的码云分支 release 不一致")
  expect(svc.calls).toEqual([])
  expect(svc.errors).toEqual([])
}, 30_000)

it("stops exporting when the current branch has commits not synchronized with its tracking branch", async () => {
  const svc = await setup()
  await fs.writeFile(path.join(svc.root, "README.md"), "ahead\n")
  await svc.git.add("README.md")
  await svc.git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ahead"])

  await svc.history.export("ses_export")

  expect(svc.modals[0]).toContain("当前分支 main 与云端配置的码云分支 main 不一致，或追踪分支 origin/main 尚未同步")
  expect(svc.calls).toEqual([])
  expect(svc.errors).toEqual([])
}, 30_000)

it("prompts before exporting with uncommitted changes and continues only when confirmed", async () => {
  const svc = await setup({ answers: [undefined, "继续"] })
  await fs.writeFile(path.join(svc.root, "uncommitted.txt"), "local change\n")

  await svc.history.export("ses_export")
  expect(svc.prompts[0]).toContain("1 个未提交项")
  expect(svc.calls).toEqual([])

  await svc.history.export("ses_export")

  expect(svc.prompts).toHaveLength(2)
  expect(svc.modals).toEqual([])
  expect(svc.errors).toEqual([])
  expect(svc.calls).toEqual(["export"])
  expect(await fs.readdir(path.join(svc.root, ".testagent", "cloud", "export"))).toHaveLength(1)
}, 30_000)
