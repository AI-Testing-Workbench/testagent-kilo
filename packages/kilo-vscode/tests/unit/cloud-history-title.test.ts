// testagent_change - new file: verifies imported archive titles replace core fork counters
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

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("uses only the cloud-origin suffix on the imported local session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-title-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")

  const archive = {
    info: {
      id: "ses_cloud",
      slug: "cloud",
      projectID: "project-1",
      workspaceID: "local-workspace",
      directory: "C:\\cloud\\repo",
      path: "src/app.ts",
      title: "Remote work (fork #7)",
      version: "1.0.0",
      time: { created: 1, updated: 2 },
    },
    messages: [],
  }
  const dir = path.join(root, ".testagent", "cloud", "import")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "session.json"), JSON.stringify(archive))

  const host = Bun.serve({
    port: 0,
    fetch: () => Response.json({ sourceSessionID: "ses_cloud", sessionID: "ses_local", forked: true }),
  })
  hosts.push(host)
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const names: Array<{ id: string; title: string; dir: string }> = []
  const errors: unknown[] = []
  const history = new CloudHistory({
    connection: {
      getClientAsync: async () => undefined,
      getServerConfig: () => ({ baseUrl: host.url.origin, password: "secret" }),
    },
    registry: reg,
    dir: () => root,
    sessionDir: async () => root,
    context: (directory) => ({ directory, workspace: "local-workspace" }),
    pluginId: "test-tech.TestAgent",
    ui: { pick: async (items) => items[0], confirm: async (_message, accept) => accept },
    rename: async (id, title, dir) => {
      names.push({ id, title, dir })
    },
    post: () => undefined,
    onError: (err) => errors.push(err),
  })

  expect(await history.fork("session.json")).toEqual({
    sourceSessionID: "ses_cloud",
    sessionID: "ses_local",
    forked: true,
  })
  expect(names).toEqual([{ id: "ses_local", title: "Remote work (来自云端)", dir: root }])
  expect(errors).toEqual([])
}, 60_000)
