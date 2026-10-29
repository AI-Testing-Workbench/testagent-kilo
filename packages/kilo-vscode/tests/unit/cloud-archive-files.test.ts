// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CoreArchiveApi, type SessionArchive } from "../../src/testagent/cloud/archive-api"
import { CloudArchiveFiles, CloudArchiveFilesError } from "../../src/testagent/cloud/archive-files"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { ensureCloudWorkspace } from "../../src/testagent/cloud/workspace"

const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-files-"))
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

function data(id: string, title: string, updated: number): SessionArchive {
  return {
    info: {
      id,
      slug: id,
      projectID: "project-1",
      workspaceID: "local-workspace",
      directory: "C:\\local\\repo",
      path: "src/app",
      title,
      version: "1.0.0",
      time: { created: 1, updated },
    },
    messages: [],
  }
}

function service(archive: CoreArchiveApi): CloudArchiveFiles {
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  return new CloudArchiveFiles({
    registry: reg,
    archive,
    context: (directory) => ({ directory, workspace: "local-workspace" }),
    onError: (err) => {
      throw err
    },
  })
}

function server(fetch: (req: Request) => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  const host = Bun.serve({ port: 0, fetch })
  servers.push(host)
  return host
}

function core(host: ReturnType<typeof Bun.serve>): CoreArchiveApi {
  return new CoreArchiveApi({
    connect: async () => undefined,
    config: () => ({ baseUrl: host.url.origin, password: "secret" }),
  })
}

function defer(): { promise: Promise<void>; release: () => void } {
  const state: { done?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    state.done = () => resolve()
  })
  return { promise, release: () => state.done?.() }
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(servers.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("码云仓库本地归档文件", () => {
  it("明确提示非 HTTP(S) remote 不受支持", async () => {
    const root = await repo()
    await simpleGit(root).raw(["remote", "set-url", "origin", "git@github.com:alice/repo.git"])
    const files = service(new CoreArchiveApi({ connect: async () => undefined, config: () => null }))

    await expect(files.list(root)).rejects.toThrow("当前码云仓库仅支持 HTTP/HTTPS remote")
  }, 30_000)

  it("递归列出有效归档、忽略无效文件并在后续扫描中发现新文件", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const dir = path.join(workspace.import, "service-1")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "older.json"), JSON.stringify(data("ses_old", "Older", 2)))
    await fs.writeFile(path.join(workspace.import, "newer.json"), JSON.stringify(data("ses_new", "Newer", 3)))
    await fs.writeFile(path.join(workspace.import, "broken.json"), "{")
    const files = service(new CoreArchiveApi({ connect: async () => undefined, config: () => null }))

    expect(await files.list(root)).toMatchObject({
      archives: [
        { key: "newer.json", sessionID: "ses_new", title: "Newer", updatedAt: 3 },
        { key: "service-1/older.json", sessionID: "ses_old", serviceId: "service-1", updatedAt: 2 },
      ],
      invalidCount: 1,
    })
    await fs.writeFile(path.join(workspace.import, "service-2.json"), JSON.stringify(data("ses_next", "Next", 4)))
    expect((await files.list(root)).archives.map((item) => item.sessionID)).toEqual(["ses_next", "ses_new", "ses_old"])
  }, 30_000)

  it("拒绝越出 import 目录的归档 key", async () => {
    const root = await repo()
    const files = service(new CoreArchiveApi({ connect: async () => undefined, config: () => null }))

    await expect(files.read(root, "../info.json")).rejects.toMatchObject<Partial<CloudArchiveFilesError>>({
      code: "invalid_path",
    })
  }, 30_000)

  it("重复确认 fork 时每次调用 core，并始终保留原归档", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const file = path.join(workspace.import, "session.json")
    const original = data("ses_fork", "Fork me", 4)
    await fs.writeFile(file, JSON.stringify(original))
    const calls: Array<{ path: string; directory: string; workspace: string | null; body: unknown }> = []
    const host = server(async (req) => {
      const url = new URL(req.url)
      calls.push({
        path: url.pathname,
        directory: req.headers.get("x-opencode-directory") ?? "",
        workspace: url.searchParams.get("workspace"),
        body: await req.json(),
      })
      return Response.json({ sourceSessionID: "ses_fork", sessionID: `fork-${calls.length}`, forked: true })
    })
    const files = service(core(host))

    expect(await files.fork(root, "session.json")).toEqual({
      sourceSessionID: "ses_fork",
      sessionID: "fork-1",
      forked: true,
    })
    expect(await files.fork(root, "session.json")).toEqual({
      sourceSessionID: "ses_fork",
      sessionID: "fork-2",
      forked: true,
    })
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.path === "/session/ses_fork/import/fork")).toBe(true)
    expect(calls.every((call) => call.directory === encodeURIComponent(root))).toBe(true)
    expect(calls.every((call) => call.workspace === "local-workspace")).toBe(true)
    expect(calls.every((call) => JSON.stringify(call.body) === JSON.stringify(original))).toBe(true)
    expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(original))
  }, 30_000)

  it("同一归档的并行确认只发出一个 fork 请求", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const file = path.join(workspace.import, "session.json")
    await fs.writeFile(file, JSON.stringify(data("ses_pending", "Pending", 1)))
    const calls: string[] = []
    const started = defer()
    const gate = defer()
    const host = server(async (req) => {
      const url = new URL(req.url)
      calls.push(url.pathname)
      started.release()
      await gate.promise
      return Response.json({ sourceSessionID: "ses_pending", sessionID: "fork-1", forked: true })
    })
    const files = service(core(host))

    const first = files.fork(root, "session.json")
    await started.promise
    await expect(files.fork(root, "session.json")).rejects.toMatchObject<Partial<CloudArchiveFilesError>>({
      code: "busy",
    })
    gate.release()
    expect(await first).toMatchObject({ sessionID: "fork-1", forked: true })
    expect(calls).toEqual(["/session/ses_pending/import/fork"])
    expect(await fs.stat(file).then((stat) => stat.isFile())).toBe(true)
  }, 30_000)
})
