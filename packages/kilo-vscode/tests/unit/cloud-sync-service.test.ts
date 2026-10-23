// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CoreArchiveApi, type SessionArchive } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import {
  CloudArchiveSyncService,
  type CloudArchiveSyncOptions,
  type CloudSyncIssue,
} from "../../src/testagent/cloud/sync-service"
import { ensureCloudWorkspace, writeCloudInfo } from "../../src/testagent/cloud/workspace"
import type { ContainerFileSyncResult, RemoteSshApi } from "../../src/testagent/cloud/remote-api"

const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
const syncs: CloudArchiveSyncService[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-sync-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")
  return root
}

function remote(
  opts: {
    status?: string | (() => string)
    getError?: () => unknown
    sync?: (source: string, target: string, conflict: string, mirror: boolean) => Promise<ContainerFileSyncResult>
  } = {},
): RemoteSshApi {
  return {
    revealSidebar: async () => undefined,
    createContainer: async () => ({ service_id: "unused", status: "running" }),
    getContainer: async (serviceId) => {
      const err = opts.getError?.()
      if (err) throw err
      return {
        service_id: serviceId,
        status: typeof opts.status === "function" ? opts.status() : (opts.status ?? "running"),
        gitee_user: "alice",
        gitee_repository: "repo",
      }
    },
    syncFiles: async (source, target, conflict, mirror) => {
      if (opts.sync) return opts.sync(source, target, conflict, mirror)
      return { direction: "download", copied: 0, skipped: 0, deleted: 0, bytesTransferred: 0, complete: true }
    },
    deleteContainer: async () => undefined,
  }
}

function api(server: ReturnType<typeof Bun.serve>): CoreArchiveApi {
  return new CoreArchiveApi({
    connect: async () => undefined,
    config: () => ({ baseUrl: server.url.origin, password: "secret" }),
  })
}

function archive(id: string, dir: string, sessionPath = "src/app"): SessionArchive {
  return {
    info: { id, directory: dir, path: sessionPath, workspaceID: "local-workspace", title: "Test" },
    messages: [{ info: { id: `${id}-message` }, parts: [{ id: `${id}-part`, type: "text", text: "archive" }] }],
  }
}

function defer(): { promise: Promise<void>; release: () => void } {
  const state: { done?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    state.done = () => resolve()
  })
  return { promise, release: () => state.done?.() }
}

function service(opts: Omit<CloudArchiveSyncOptions, "registry">): CloudArchiveSyncService {
  const sync = new CloudArchiveSyncService({ ...opts, registry: new WorkspaceSyncRegistry() })
  syncs.push(sync)
  return sync
}

async function waitFor(test: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 3_000
  while (Date.now() < end) {
    if (await test()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("等待码云同步任务超时")
}

function server(fetch: (req: Request) => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  const value = Bun.serve({ port: 0, fetch })
  servers.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.dispose()))
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("码云仓库归档同步", () => {
  it("按周期重复检查运行中的远程服务并保留已下载归档", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    await writeCloudInfo(root, { serviceIds: ["service-1"] })
    const file = path.join(workspace.import, "service-1", "existing.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "existing archive")
    const state = { checks: 0, calls: 0 }
    const issues: CloudSyncIssue[] = []
    const sync = service({
      mode: "local",
      archive: new CoreArchiveApi({ connect: async () => undefined, config: () => null }),
      remote: async () =>
        remote({
          status: "running",
          getError: () => {
            state.checks++
            return undefined
          },
          sync: async () => {
            state.calls++
            return { direction: "download", copied: 0, skipped: 1, deleted: 0, bytesTransferred: 0, complete: false }
          },
        }),
      intervalMs: 20,
      heartbeatMs: 100,
      leaseMs: 2_000,
      onError: (issue) => issues.push(issue),
    })

    expect(await sync.refresh(root)).toBe(true)
    await waitFor(async () => state.calls >= 2)
    await sync.dispose()

    expect(state.checks).toBeGreaterThanOrEqual(2)
    expect(await fs.readFile(file, "utf8")).toBe("existing archive")
    expect(issues).toEqual([])
  }, 30_000)

  it("本地模式在服务配置和运行状态恢复后下载 export，skip 不删除任一侧文件", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    await writeCloudInfo(root, { serviceIds: ["service-1"] })
    const state = {
      checks: 0,
      remoteCalls: 0,
      status: "stopped",
      calls: [] as Array<{ source: string; target: string; conflict: string; mirror: boolean }>,
    }
    const issues: CloudSyncIssue[] = []
    const sync = service({
      mode: "local",
      archive: new CoreArchiveApi({ connect: async () => undefined, config: () => null }),
      remote: async () => {
        state.remoteCalls++
        return remote({
          getError: () =>
            state.checks++ === 0
              ? Object.assign(new Error("not configured"), { code: "service_not_configured" })
              : undefined,
          status: () => state.status,
          sync: async (source, target, conflict, mirror) => {
            state.calls.push({ source, target, conflict, mirror })
            await fs.mkdir(target, { recursive: true })
            if (state.calls.length === 1) throw Object.assign(new Error("timeout"), { code: "network_timeout" })
            if (state.calls.length === 2) await fs.writeFile(path.join(target, "version.json"), "archive")
            return state.calls.length === 2
              ? { direction: "download", copied: 1, skipped: 0, deleted: 0, bytesTransferred: 7, complete: true }
              : { direction: "download", copied: 0, skipped: 1, deleted: 0, bytesTransferred: 0, complete: false }
          },
        })
      },
      intervalMs: 20,
      heartbeatMs: 100,
      leaseMs: 2_000,
      onError: (issue) => issues.push(issue),
    })

    expect(await sync.refresh(root)).toBe(true)
    await waitFor(async () => state.checks >= 2).catch((err) => {
      throw new Error(
        `本地轮询状态 checks=${state.checks}, remoteCalls=${state.remoteCalls}, issues=${JSON.stringify(issues)}: ${String(err)}`,
      )
    })
    expect(state.calls).toHaveLength(0)
    state.status = "running"
    await waitFor(async () => state.calls.length >= 3)
    await sync.dispose()

    expect(state.calls[0]).toEqual({
      source: "service-1:/app/repo/.testagent/cloud/export",
      target: path.join(workspace.import, "service-1"),
      conflict: "skip",
      mirror: false,
    })
    expect(await fs.readFile(path.join(workspace.import, "service-1", "version.json"), "utf8")).toBe("archive")
    expect(issues).toEqual([
      { stage: "service_status", serviceId: "service-1", code: "service_not_configured" },
      { stage: "download", serviceId: "service-1", code: "network_timeout" },
    ])
  }, 30_000)

  it("云端模式 preserve 成功后删除源文件，并只改写请求副本的目的路径", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const file = path.join(workspace.import, "service-1", "session.json")
    const next = path.join(workspace.import, "service-2", "session.json")
    const original = archive("ses_cloud", "C:\\local\\repo")
    const other = archive("ses_cloud_2", "C:\\local\\repo", "other")
    const text = `${JSON.stringify(original, null, 2)}\n`
    const more = `${JSON.stringify(other, null, 2)}\n`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.mkdir(path.dirname(next), { recursive: true })
    await fs.writeFile(file, text)
    await fs.writeFile(next, more)
    const state = {
      active: 0,
      peak: 0,
      calls: [] as Array<{ path: string; directory: string; workspace: string | null; body: unknown }>,
    }
    const received = defer()
    const host = server(async (req) => {
      const url = new URL(req.url)
      state.active++
      state.peak = Math.max(state.peak, state.active)
      const body: unknown = await req.json()
      state.calls.push({
        path: url.pathname,
        directory: req.headers.get("x-opencode-directory") ?? "",
        workspace: url.searchParams.get("workspace"),
        body,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      state.active--
      if (state.calls.length === 2) received.release()
      return Response.json({
        sourceSessionID: (body as SessionArchive).info.id,
        sessionID: (body as SessionArchive).info.id,
        forked: false,
      })
    })
    const issues: CloudSyncIssue[] = []
    const sync = service({
      mode: "cloud",
      archive: api(host),
      remote: async () => {
        throw new Error("云端 preserve 不调用 Remote SSH")
      },
      context: (dir) => ({ directory: dir, workspace: "workspace-cloud" }),
      intervalMs: 20,
      heartbeatMs: 100,
      leaseMs: 2_000,
      onError: (issue) => issues.push(issue),
    })

    expect(await sync.refresh(file)).toBe(true)
    await received.promise
    await waitFor(
      async () =>
        (await fs.stat(file).catch(() => undefined)) === undefined &&
        (await fs.stat(next).catch(() => undefined)) === undefined,
    )
    await sync.dispose()

    expect(state.calls).toHaveLength(2)
    expect(state.peak).toBe(1)
    expect(state.calls.map((call) => call.path)).toEqual(["/session/ses_cloud/import", "/session/ses_cloud_2/import"])
    expect(state.calls[0].directory).toBe(encodeURIComponent(root))
    expect(state.calls[0].workspace).toBe("workspace-cloud")
    expect(state.calls[0].body).toMatchObject({
      info: { id: "ses_cloud", directory: root, path: "src/app", workspaceID: "workspace-cloud" },
      messages: original.messages,
    })
    expect(state.calls[1].body).toMatchObject({
      info: { id: "ses_cloud_2", directory: root, path: "other", workspaceID: "workspace-cloud" },
      messages: other.messages,
    })
    expect(issues).toEqual([])
    expect(text).toBe(`${JSON.stringify(original, null, 2)}\n`)
    expect(more).toBe(`${JSON.stringify(other, null, 2)}\n`)
    expect(original.info.directory).toBe("C:\\local\\repo")
    expect(other.info.directory).toBe("C:\\local\\repo")
  }, 30_000)

  it("preserve 失败时保留原归档且错误记录不含正文", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const file = path.join(workspace.import, "session.json")
    const original = archive("ses_error", "C:\\local\\repo")
    const text = `${JSON.stringify(original, null, 2)}\n`
    await fs.writeFile(file, text)
    const received = defer()
    const issues: CloudSyncIssue[] = []
    const host = server(async (req) => {
      await req.json()
      received.release()
      return new Response("private archive error body", { status: 503 })
    })
    const sync = service({
      mode: "cloud",
      archive: api(host),
      remote: async () => {
        throw new Error("云端 preserve 不调用 Remote SSH")
      },
      intervalMs: 500,
      heartbeatMs: 100,
      leaseMs: 2_000,
      onError: (issue) => issues.push(issue),
    })

    expect(await sync.refresh(root)).toBe(true)
    await received.promise
    await waitFor(async () => issues.length > 0)
    await sync.dispose()

    expect(await fs.readFile(file, "utf8")).toBe(text)
    expect(issues[0]).toEqual({ stage: "preserve", code: "http_error" })
    expect(JSON.stringify(issues)).not.toContain("private archive error body")
  }, 30_000)
})
