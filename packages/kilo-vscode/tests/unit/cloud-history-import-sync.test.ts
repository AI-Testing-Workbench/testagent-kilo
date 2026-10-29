// testagent_change - new file: verify archive import queries its service ID and warns on a branch mismatch
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import type { SessionArchive } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudHistory } from "../../src/testagent/cloud/history"
import type { RemoteSshApi } from "../../src/testagent/cloud/ssh-api"

const roots: string[] = []
const hosts: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-history-import-sync-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")
  return root
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("imports the session and warns when the current local branch differs from its service branch", async () => {
  const root = await repo()
  const data: SessionArchive = {
    info: {
      id: "ses_imported",
      slug: "imported",
      projectID: "project-1",
      workspaceID: "workspace-1",
      directory: root,
      path: "src/app.ts",
      title: "Imported session",
      version: "1.0.0",
      time: { created: 1, updated: 2 },
    },
    messages: [],
  }
  const calls: string[] = []
  const host = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`)
      return Response.json({ sourceSessionID: data.info.id, sessionID: "ses_forked", forked: true })
    },
  })
  hosts.push(host)
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const warnings: string[] = []
  const errs: unknown[] = []
  const api: RemoteSshApi = {
    revealSidebar: async () => undefined,
    createContainer: async () => ({ service_id: "unused", status: "running" }),
    getContainer: async (serviceId) => {
      calls.push(`GET service ${serviceId}`)
      return {
        service_id: serviceId,
        status: "running",
        gitee_url: "https://github.com",
        gitee_user: "alice",
        gitee_repository: "repo",
        gitee_branch: "develop",
      }
    },
    syncFiles: async () => ({
      direction: "download",
      copied: 0,
      skipped: 0,
      deleted: 0,
      bytesTransferred: 0,
      complete: true,
    }),
    deleteContainer: async () => undefined,
  }
  const history = new CloudHistory({
    connection: {
      getClientAsync: async () => undefined,
      getServerConfig: () => ({ baseUrl: host.url.origin, password: "secret" }),
    },
    registry: reg,
    dir: () => root,
    sessionDir: async () => root,
    context: (directory) => ({ directory, workspace: "workspace-1" }),
    pluginId: "test-tech.TestAgent",
    ui: {
      pick: async (items) => items[0],
      confirm: async (_message, accept) => accept,
    },
    post: () => undefined,
    onError: (err) => errs.push(err),
    warning: (message) => warnings.push(message),
    remote: async () => api,
  })
  const dir = path.join(root, ".testagent", "cloud", "import", "service-42")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "archive.json"), JSON.stringify(data))

  const result = await history.fork("service-42/archive.json")

  expect(result).toEqual({ sourceSessionID: data.info.id, sessionID: "ses_forked", forked: true })
  expect(calls).toEqual(["POST /session/ses_imported/import/fork", "GET service service-42"])
  expect(warnings).toEqual(["本地当前分支“main”与码云分支“develop”不匹配。\n会话已导入，但未将码云仓库的更新拉取到本地工作区仓库。"])
  expect(errs).toEqual([])
}, 30_000)
