// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CloudFileError, writeAtomic } from "../../src/testagent/cloud/atomic"
import {
  CoreArchiveApi,
  CoreArchiveError,
  createCoreArchiveApi,
  exportSessionArchive,
  type SessionArchive,
} from "../../src/testagent/cloud/archive-api"

type TestServer = ReturnType<typeof Bun.serve>

const roots: string[] = []
const servers: TestServer[] = []

function serve(fetch: (req: Request) => Response | Promise<Response>): TestServer {
  const server = Bun.serve({ port: 0, fetch })
  servers.push(server)
  return server
}

function archive(id = "ses_1", title = "Session"): SessionArchive {
  return {
    info: { id, directory: "C:\\repo", title, time: { created: 1, updated: 2 } },
    messages: [{ info: { id: "msg_1" }, parts: [{ id: "prt_1", type: "text", text: "hello" }] }],
  }
}

function make(baseUrl: string, state: { dirs: string[] }, password = "secret"): CoreArchiveApi {
  return createCoreArchiveApi({
    getClientAsync: async (dir) => {
      if (dir) state.dirs.push(dir)
    },
    getServerConfig: () => ({ baseUrl, password }),
  })
}

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-archive-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.addRemote("origin", "https://github.com/test/archive.git")
  return root
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("core archive HTTP API", () => {
  it("原子文件写入失败时抛出中文错误", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-file-error-"))
    roots.push(root)

    await expect(writeAtomic(path.join(root, "missing", "archive.json"), "{}\n")).rejects.toMatchObject<
      Partial<CloudFileError>
    >({
      code: "write_failed",
      message: "无法写入本地码云仓库临时文件",
    })
  })

  it("exports through the connected core with workspace context and no sanitize query", async () => {
    const state = { dirs: [] as string[], url: "", method: "", directory: "", auth: "" }
    const server = serve((req) => {
      state.url = req.url
      state.method = req.method
      state.directory = req.headers.get("x-opencode-directory") ?? ""
      state.auth = req.headers.get("authorization") ?? ""
      return Response.json(archive())
    })
    const api = make(server.url.origin, state)
    const ctx = { directory: "C:\\Git 仓库\\repo", workspace: "workspace-1" }

    expect(await api.exportArchive("ses_1", ctx)).toEqual(archive())
    expect(state.dirs).toEqual([ctx.directory])
    expect(state.method).toBe("GET")
    expect(new URL(state.url).pathname).toBe("/session/ses_1/export")
    expect(new URL(state.url).searchParams.get("workspace")).toBe(ctx.workspace)
    expect(new URL(state.url).searchParams.has("sanitize")).toBe(false)
    expect(state.directory).toBe(encodeURIComponent(ctx.directory))
    expect(state.auth).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
  }, 15_000)

  it("preserves and forks the full archive using its matching path ID", async () => {
    const calls: Array<{ path: string; method: string; body: unknown; workspace: string | null }> = []
    const server = serve(async (req) => {
      calls.push({
        path: new URL(req.url).pathname,
        method: req.method,
        body: await req.json(),
        workspace: new URL(req.url).searchParams.get("workspace"),
      })
      const forked = new URL(req.url).pathname.endsWith("/import/fork")
      return Response.json({ sourceSessionID: "ses_1", sessionID: forked ? "ses_2" : "ses_1", forked })
    })
    const api = make(server.url.origin, { dirs: [] })
    const data = archive()
    const ctx = { directory: "C:\\cloud\\repo", workspace: "workspace-cloud" }

    expect(await api.preserveArchive(data, ctx)).toEqual({
      sourceSessionID: "ses_1",
      sessionID: "ses_1",
      forked: false,
    })
    expect(await api.forkArchive(data, ctx)).toEqual({ sourceSessionID: "ses_1", sessionID: "ses_2", forked: true })
    expect(calls).toEqual([
      {
        path: "/session/ses_1/import",
        method: "POST",
        body: data,
        workspace: "workspace-cloud",
      },
      {
        path: "/session/ses_1/import/fork",
        method: "POST",
        body: data,
        workspace: "workspace-cloud",
      },
    ])
  }, 15_000)

  it("reports disconnected core, HTTP failures, and invalid archive responses", async () => {
    const disconnected = new CoreArchiveApi({ connect: async () => undefined, config: () => null })
    await expect(disconnected.exportArchive("ses_1", { directory: "C:\\repo" })).rejects.toMatchObject<
      Partial<CoreArchiveError>
    >({ code: "not_connected" })

    const failed = new CoreArchiveApi({
      connect: async () => {
        throw new Error("connection details")
      },
      config: () => null,
    })
    await expect(failed.exportArchive("ses_1", { directory: "C:\\repo" })).rejects.toMatchObject<
      Partial<CoreArchiveError>
    >({ code: "not_connected", message: "连接本地 core 服务失败" })

    const failing = serve(() => new Response("sensitive backend details", { status: 503 }))
    await expect(
      make(failing.url.origin, { dirs: [] }).exportArchive("ses_1", { directory: "C:\\repo" }),
    ).rejects.toMatchObject<Partial<CoreArchiveError>>({ code: "http_error", status: 503 })

    const invalid = serve(() => Response.json({ info: { id: "ses_1" }, messages: "invalid" }))
    await expect(
      make(invalid.url.origin, { dirs: [] }).exportArchive("ses_1", { directory: "C:\\repo" }),
    ).rejects.toMatchObject<Partial<CoreArchiveError>>({ code: "invalid_response" })

    const mismatch = serve(() => Response.json(archive("ses_other")))
    await expect(
      make(mismatch.url.origin, { dirs: [] }).exportArchive("ses_1", { directory: "C:\\repo" }),
    ).rejects.toMatchObject<Partial<CoreArchiveError>>({ code: "session_mismatch" })
  }, 15_000)

  it("writes versioned exports atomically under the local codecloud repo cloud directory", async () => {
    const state = { calls: 0 }
    const server = serve(() => Response.json(archive("ses_1", `Version ${++state.calls}`)))
    const api = make(server.url.origin, { dirs: [] })
    const root = await repo()
    const ctx = { directory: root }

    const first = await exportSessionArchive(root, api, "ses_1", ctx)
    const second = await exportSessionArchive(root, api, "ses_1", ctx)

    expect(first.file).toContain(path.join(".testagent", "cloud", "export"))
    expect(first.name).not.toBe(second.name)
    expect(JSON.parse(await fs.readFile(first.file, "utf8"))).toEqual(archive("ses_1", "Version 1"))
    expect(JSON.parse(await fs.readFile(second.file, "utf8"))).toEqual(archive("ses_1", "Version 2"))
    expect((await fs.readdir(path.dirname(first.file))).some((name) => name.endsWith(".tmp"))).toBe(false)
    expect((await simpleGit(root).status()).files).toHaveLength(0)
  }, 15_000)
})
