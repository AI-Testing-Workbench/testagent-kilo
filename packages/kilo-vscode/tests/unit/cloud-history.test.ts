// testagent_change - new file: exercise host archive history against local HTTP and filesystem services
import { afterEach, describe, expect, it } from "bun:test"
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

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-history-"))
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

function archive(): SessionArchive {
  return {
    info: {
      id: "ses_history",
      slug: "history",
      projectID: "project-1",
      workspaceID: "local-workspace",
      directory: "C:\\local\\repo",
      path: "src/app.ts",
      title: "Cloud history workflow",
      version: "1.0.0",
      time: { created: 1, updated: 2 },
    },
    messages: [],
  }
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("Cloud history host workflow", () => {
  it("lists and reads local archives, forks through core, exports locally, and replays cached metadata", async () => {
    const root = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const data = archive()
    const calls: Array<{
      method: string
      path: string
      directory: string
      auth: string
      workspace: string | null
      body?: unknown
    }> = []
    const host = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        calls.push({
          method: req.method,
          path: url.pathname,
          directory: req.headers.get("x-opencode-directory") ?? "",
          auth: req.headers.get("authorization") ?? "",
          workspace: url.searchParams.get("workspace"),
          body: req.method === "POST" ? await req.json() : undefined,
        })
        if (req.method === "GET") return Response.json(data)
        return Response.json({ sourceSessionID: "ses_history", sessionID: "ses_forked", forked: true })
      },
    })
    hosts.push(host)
    const messages: unknown[] = []
    const errs: unknown[] = []
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
      onError: (err) => errs.push(err),
    })
    const workspace = path.join(root, ".testagent", "cloud", "import")
    await fs.mkdir(workspace, { recursive: true })
    const file = path.join(workspace, "session.json")
    await fs.writeFile(file, JSON.stringify(data))

    await history.list()
    expect(messages.at(-1)).toMatchObject({
      type: "cloudArchiveListLoaded",
      archives: [{ key: "session.json", sessionID: "ses_history", title: "Cloud history workflow" }],
      invalidCount: 0,
    })
    await history.read("session.json")
    expect(messages.at(-1)).toMatchObject({
      type: "cloudArchiveLoaded",
      key: "session.json",
      archive: { info: data.info },
    })
    expect(await history.fork("session.json")).toEqual({
      sourceSessionID: "ses_history",
      sessionID: "ses_forked",
      forked: true,
    })
    await history.export("ses_history")
    const done = messages.at(-1) as { action: string; pending: boolean }
    expect(done.action).toBe("export")
    expect(done.pending).toBe(false)
    expect(await fs.readdir(path.join(root, ".testagent", "cloud", "export"))).toHaveLength(1)
    expect(messages.slice(-2)).toMatchObject([
      { type: "cloudActionProgress", action: "export", sessionID: "ses_history", pending: true },
      {
        type: "cloudActionProgress",
        action: "export",
        sessionID: "ses_history",
        pending: false,
      },
    ])
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/session/ses_history/import/fork"],
      ["GET", "/session/ses_history/export"],
    ])
    expect(calls.every((call) => call.directory === encodeURIComponent(root))).toBe(true)
    expect(calls.every((call) => call.auth === `Basic ${Buffer.from("opencode:secret").toString("base64")}`)).toBe(true)
    expect(calls.every((call) => call.workspace === "local-workspace")).toBe(true)
    expect(calls[0]?.body).toEqual(data)
    expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(data))
    expect(done).toMatchObject({ action: "export", pending: false })
    const name = (await fs.readdir(path.join(root, ".testagent", "cloud", "export")))[0]
    expect(name).toMatch(/^[a-f\d-]+\.json$/)
    expect(await fs.readFile(path.join(root, ".testagent", "cloud", "export", name!), "utf8")).toBe(
      `${JSON.stringify(data, null, 2)}\n`,
    )
    history.push()
    expect(messages.at(-1)).toMatchObject({ type: "cloudArchiveListLoaded", archives: [{ key: "session.json" }] })
    expect(errs).toEqual([])
  }, 60_000)
})
