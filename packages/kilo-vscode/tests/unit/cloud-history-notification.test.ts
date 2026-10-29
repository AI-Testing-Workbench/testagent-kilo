// testagent_change - new file: route export success through the host notification callback
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import type { SessionArchive } from "../../src/testagent/cloud/archive-api"
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

it("routes exported filenames to the success callback without posting a list notice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-history-notification-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")

  const data: SessionArchive = {
    info: {
      id: "ses_notification",
      slug: "notification",
      projectID: "project-1",
      workspaceID: "local-workspace",
      directory: root,
      path: "",
      title: "Export notification",
      version: "1.0.0",
      time: { created: 1, updated: 2 },
    },
    messages: [],
  }
  const host = Bun.serve({ port: 0, fetch: () => Response.json(data) })
  hosts.push(host)
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const notices: string[] = []
  const messages: unknown[] = []
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
    ui: {
      pick: async (items) => items[0],
      confirm: async (_message, accept) => accept,
    },
    post: (message) => messages.push(message),
    onError: (err) => errors.push(err),
    success: (message) => notices.push(message),
  })

  await history.export(data.info.id)

  const files = await fs.readdir(path.join(root, ".testagent", "cloud", "export"))
  expect(files).toHaveLength(1)
  expect(notices).toEqual([`已导出为 ${files[0]}`])
  expect(messages).toEqual([
    { type: "cloudActionProgress", action: "export", sessionID: data.info.id, pending: true },
    { type: "cloudActionProgress", action: "export", sessionID: data.info.id, pending: false },
  ])
  expect(errors).toEqual([])
}, 30_000)
