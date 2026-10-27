// testagent_change - new file: verify upload progress lifecycle and host success notification
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudHistory } from "../../src/testagent/cloud/history"
import type { ContainerCreateRequest, RemoteSshApi } from "../../src/testagent/cloud/remote-api"

const roots: string[] = []
const hosts: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("starts progress at upload click and ends it immediately before container creation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-upload-progress-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")
  const hash = await git.revparse("HEAD")
  await git.raw(["update-ref", "refs/remotes/origin/main", hash])
  await git.raw(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])

  const events: string[] = []
  const msgs: unknown[] = []
  const notices: string[] = []
  const host = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        info: {
          id: "ses_progress",
          slug: "progress",
          projectID: "project-local",
          directory: root,
          title: "Progress test",
          version: "1.0.0",
          time: { created: 1, updated: 2 },
        },
        messages: [],
      }),
  })
  hosts.push(host)
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const api: RemoteSshApi = {
    revealSidebar: async () => {
      events.push("reveal")
    },
    createContainer: async (req: ContainerCreateRequest) => {
      events.push("create")
      await req.callbacks.containerPrepared({ serviceId: "service-progress", host: "cloud-host" })
      return { service_id: "service-progress", status: "running" }
    },
    getContainer: async () => {
      throw new Error("unexpected status lookup")
    },
    syncFiles: async (source) => {
      expect(await fs.readFile(source, "utf8")).toContain("ses_progress")
      return { direction: "upload", copied: 1, skipped: 0, deleted: 0, bytesTransferred: 1, complete: true }
    },
    deleteContainer: async () => undefined,
  }
  const history = new CloudHistory({
    connection: {
      getClientAsync: async () => undefined,
      getServerConfig: () => ({ baseUrl: host.url.origin, password: "secret" }),
    },
    registry: reg,
    dir: () => root,
    sessionDir: async () => {
      events.push("session")
      return root
    },
    context: (directory) => ({ directory }),
    pluginId: "test-tech.TestAgent",
    remote: async () => api,
    ui: {
      pick: async (items) => {
        events.push("pick")
        return items[0]
      },
      confirm: async (_message, accept) => accept,
    },
    progress: async (task) => {
      events.push("progress-start")
      return task(() => events.push("progress-end")).finally(() => {
        if (!events.includes("progress-end")) events.push("progress-end")
      })
    },
    success: (message) => notices.push(message),
    post: (message) => msgs.push(message),
    onError: (err) => {
      throw err
    },
  })

  await history.upload("ses_progress")

  if (!events.includes("create")) throw new Error(JSON.stringify({ events, msgs }))
  expect(events[0]).toBe("progress-start")
  expect(events.indexOf("session")).toBeGreaterThan(events.indexOf("progress-start"))
  expect(events.indexOf("progress-end")).toBeLessThan(events.indexOf("create"))
  expect(msgs.at(-1)).toMatchObject({
    type: "cloudActionProgress",
    action: "upload",
    sessionID: "ses_progress",
    pending: false,
  })
  expect(notices).toEqual(["会话已上传到云端"])
  expect(msgs).toMatchObject([
    { type: "cloudActionProgress", action: "upload", sessionID: "ses_progress", pending: true },
    { type: "cloudActionProgress", action: "upload", sessionID: "ses_progress", pending: false },
  ])
}, 60_000)
