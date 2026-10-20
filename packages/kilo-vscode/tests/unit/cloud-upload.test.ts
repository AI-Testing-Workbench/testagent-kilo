// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import type { SessionArchive } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import type { CloudGitItem, CloudGitQuickPickOptions, CloudGitUi } from "../../src/testagent/cloud/git-preflight"
import { CloudUploadError, CloudUploadService } from "../../src/testagent/cloud/upload"
import { ensureCloudWorkspace, readCloudInfo, writeCloudInfo } from "../../src/testagent/cloud/workspace"
import type {
  ContainerConfigEntry,
  ContainerCreateOptions,
  ContainerCreateRequest,
  ContainerFileSyncResult,
  RemoteSshApi,
} from "../../src/testagent/cloud/remote-api"

const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

async function repo(name = "repo"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-upload-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", `https://github.com/alice/${name}.git`)
  const hash = await git.revparse("HEAD")
  await git.raw(["update-ref", "refs/remotes/origin/main", hash])
  await git.raw(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
  return root
}

function archive(id = "ses_1"): SessionArchive {
  return {
    info: { id, directory: "unused", title: "Test", time: { created: 1, updated: 2 } },
    messages: [{ info: { id: "msg_1" }, parts: [{ id: "prt_1", type: "text", text: "unmodified archive content" }] }],
  }
}

function api(): { server: ReturnType<typeof Bun.serve>; dirs: string[] } {
  const dirs: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      dirs.push(req.headers.get("x-opencode-directory") ?? "")
      return Response.json(archive())
    },
  })
  servers.push(server)
  return { server, dirs }
}

function connection(server: ReturnType<typeof Bun.serve>) {
  return {
    getClientAsync: async () => undefined,
    getServerConfig: () => ({ baseUrl: server.url.origin, password: "secret" }),
  }
}

function remote(
  state: {
    reqs: ContainerCreateRequest[]
    syncs: Array<{
      source: string
      target: string
      conflict: string
      mirror: boolean
      container?: ContainerConfigEntry
    }>
    deleted: string[]
    data: string[]
    calls: string[]
    createOptions: ContainerCreateOptions[]
  },
  opts: {
    missing?: boolean
    status?: string
    callback?: boolean
    callbackId?: string
    responseId?: string
    initFail?: boolean
    failSync?: boolean
    cleanup?: boolean
    wait?: Promise<void>
    onSync?: () => void
  } = {},
): RemoteSshApi {
  return {
    revealSidebar: async () => {
      state.calls.push("revealSidebar")
    },
    createContainer: async (req, options) => {
      state.calls.push("createContainer")
      state.reqs.push(req)
      state.createOptions.push(options ?? {})
      if (opts.initFail) {
        throw Object.assign(new Error("container initialization cancelled"), {
          name: "ContainerInitializationError",
          code: "creation_cancelled",
        })
      }
      const container = { serviceId: opts.callbackId ?? "service-1", host: "container-host" }
      if (opts.callback !== false) {
        try {
          await req.callbacks.containerPrepared(container)
        } catch (err) {
          if (!opts.cleanup) state.deleted.push(container.serviceId)
          throw Object.assign(new Error("container callback failed"), {
            code: "callback_failed",
            serviceId: container.serviceId,
            cleanupError: opts.cleanup ? new Error("container cleanup failed") : undefined,
            cause: err,
          })
        }
      }
      return { service_id: opts.responseId ?? container.serviceId, status: "running" }
    },
    getContainer: async (serviceId) => {
      if (opts.missing)
        throw Object.assign(new Error("service does not exist"), { code: "http_error", statusCode: 404 })
      return {
        service_id: serviceId,
        status: opts.status ?? "running",
        gitee_user: "alice",
        gitee_repository: "repo",
      }
    },
    syncFiles: async (source, target, conflict, mirror, container) => {
      state.calls.push("syncFiles")
      state.syncs.push({ source, target, conflict, mirror, container })
      state.data.push(await fs.readFile(source, "utf8"))
      opts.onSync?.()
      if (opts.wait) await opts.wait
      if (opts.failSync) throw new Error("remote transfer failed")
      const result: ContainerFileSyncResult = {
        direction: "upload",
        copied: 1,
        skipped: 0,
        deleted: 0,
        bytesTransferred: 42,
        complete: true,
      }
      return result
    },
    deleteContainer: async (id) => {
      state.deleted.push(id)
    },
  }
}

function ui(branch = "main", pick = true): CloudGitUi {
  return {
    pick: async (items: readonly CloudGitItem[], _opts: CloudGitQuickPickOptions) =>
      pick ? items.find((item) => item.label === branch) : undefined,
    confirm: async () => "取消",
  }
}

function setup(remoteOpts: Parameters<typeof remote>[1] = {}) {
  const state = {
    reqs: [] as ContainerCreateRequest[],
    syncs: [] as Array<{
      source: string
      target: string
      conflict: string
      mirror: boolean
      container?: ContainerConfigEntry
    }>,
    deleted: [] as string[],
    data: [] as string[],
    calls: [] as string[],
    createOptions: [] as ContainerCreateOptions[],
  }
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const server = api()
  const upload = new CloudUploadService({
    connection: connection(server.server),
    registry: reg,
    remote: async () => remote(state, remoteOpts),
    pluginId: "test-tech.TestAgent",
    onError: (err) => {
      throw err
    },
  })
  return { state, registry: reg, server, upload }
}

// testagent_change - read only the already-created status file, avoiding another Git probe per retry assertion
async function readInfo(root: string) {
  return JSON.parse(await fs.readFile(path.join(root, ".testagent", "cloud", "info.json"), "utf8")) as {
    serviceIds: string[]
  }
}

// testagent_change start - retry a failed attempt with a fresh remote create response
function retry(svc: ReturnType<typeof setup>, opts: Parameters<typeof remote>[1] = {}) {
  return new CloudUploadService({
    connection: connection(svc.server.server),
    registry: svc.registry,
    remote: async () => remote(svc.state, opts),
    pluginId: "test-tech.TestAgent",
    onError: (err) => {
      throw err
    },
  })
}
// testagent_change end

function deferred(): { promise: Promise<void>; release: () => void } {
  const state: { release?: () => void } = {}
  const promise = new Promise<void>((resolve) => {
    state.release = () => resolve()
  })
  return { promise, release: () => state.release?.() }
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("码云仓库上云服务", () => {
  it("removes deleted IDs but keeps stopped services bound", async () => {
    const root = await repo()
    await ensureCloudWorkspace(root)
    await writeCloudInfo(root, { serviceIds: ["service-old"] })
    const svc = setup({ missing: true })
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: true, root })
    expect(await readInfo(root)).toEqual({ serviceIds: [] })

    await writeCloudInfo(root, { serviceIds: ["service-stopped"] })
    const stop = setup({ status: "stopped" })
    expect(await stop.upload.state(root, root)).toMatchObject({
      enabled: false,
      serviceId: "service-stopped",
      reason: "service_exists",
    })
    expect(await readInfo(root)).toEqual({ serviceIds: ["service-stopped"] })
  }, 15_000)

  it("uploads the local archive in containerPrepared, records the ID, then removes the file", async () => {
    const root = await repo()
    const svc = setup()

    const result = await svc.upload.upload(root, "ses_1", root, ui())
    const workspace = await ensureCloudWorkspace(root)

    expect(result).toMatchObject({ serviceId: "service-1", status: "running" })
    expect(svc.state.calls.slice(0, 3)).toEqual(["revealSidebar", "createContainer", "syncFiles"])
    expect(svc.state.createOptions).toEqual([{ showNotifications: true }])
    expect(svc.state.reqs[0]).toMatchObject({
      plugin_id: "test-tech.TestAgent",
      type: "testagent_cloud",
      gitee_user: "alice",
      gitee_repository: "repo",
      gitee_branch: "main",
      gitee_url: "https://github.com",
    })
    expect(svc.state.syncs[0]).toMatchObject({
      source: expect.stringContaining(path.join(".testagent", "cloud", "export")),
      target: expect.stringMatching(/^service-1:\/app\/repo\/\.testagent\/cloud\/import\/.+\.json$/),
      conflict: "overwrite",
      mirror: false,
      container: { serviceId: "service-1", host: "container-host" },
    })
    expect(svc.state.data[0]).toContain("unmodified archive content")
    expect(await readCloudInfo(root)).toEqual({ serviceIds: ["service-1"] })
    if (!result) throw new Error("Upload returned no result")
    expect(await fs.stat(path.join(workspace.export, result.archiveName)).catch(() => undefined)).toBeUndefined()
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, reason: "service_exists" })
    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject<Partial<CloudUploadError>>({
      code: "service_exists",
    })
    expect(svc.state.reqs).toHaveLength(1)
  }, 20_000)

  it("does not export or create a service when branch selection is canceled", async () => {
    const root = await repo()
    const svc = setup()

    expect(await svc.upload.upload(root, "ses_1", root, ui("main", false))).toBeUndefined()
    expect(svc.server.dirs).toHaveLength(0)
    expect(svc.state.reqs).toHaveLength(0)
    expect(await readCloudInfo(root)).toEqual({ serviceIds: [] })
  }, 15_000)

  it("retains the export when callback upload fails and cleanup is confirmed", async () => {
    const root = await repo()
    const svc = setup({ failSync: true })

    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject({ code: "callback_failed" })
    const exp = path.join(root, ".testagent", "cloud", "export")
    expect(await readInfo(root)).toEqual({ serviceIds: [] })
    expect(svc.state.deleted).toEqual(["service-1"])
    expect(await fs.readdir(exp)).toHaveLength(1)
    expect((await svc.upload.state(root, root)).enabled).toBe(true)
  }, 20_000)

  it("allows retry after callback cleanup fails", async () => {
    const root = await repo()
    const svc = setup({ failSync: true, cleanup: true })

    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject({ code: "remote_cleanup_failed" })
    const exp = path.join(root, ".testagent", "cloud", "export")
    /* testagent_change start - previous sticky-state assertions retained for reference
    expect(await readCloudInfo(root)).toEqual({ serviceIds: ["service-1"] })
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, reason: "service_unconfirmed" })
    testagent_change end */
    expect(await readInfo(root)).toEqual({ serviceIds: [] })
    expect(svc.state.deleted).toEqual([])
    expect(await fs.readdir(exp)).toHaveLength(1)

    const next = retry(svc, { callbackId: "service-2", responseId: "service-2" })
    await expect(next.upload(root, "ses_1", root, ui())).resolves.toMatchObject({ serviceId: "service-2" })
    expect(svc.state.reqs).toHaveLength(2)
    expect(await readInfo(root)).toEqual({ serviceIds: ["service-2"] })
  }, 60_000)

  it("does not bind an ID and retains the archive if callback identity mismatches", async () => {
    const root = await repo()
    const svc = setup({ callbackId: "callback-service", responseId: "response-service" })

    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject<Partial<CloudUploadError>>({
      code: "service_mismatch",
      serviceId: "response-service",
    })
    const exp = path.join(root, ".testagent", "cloud", "export")
    expect(await readInfo(root)).toEqual({ serviceIds: [] })
    expect(await fs.readdir(exp)).toHaveLength(1)
    /* testagent_change start - previous retained-lease assertions kept for reference
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, reason: "service_unconfirmed" })
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const next = new CloudUploadService({
      connection: connection(svc.server.server),
      registry: reg,
      remote: async () => remote(svc.state),
      pluginId: "test-tech.TestAgent",
      onError: (err) => { throw err },
    })
    await expect(next.upload(root, "ses_1", root, ui())).rejects.toThrow("另一个 TS Code 工作台窗口")
    testagent_change end */
    const next = retry(svc, { callbackId: "service-2", responseId: "service-2" })
    await expect(next.upload(root, "ses_1", root, ui())).resolves.toMatchObject({ serviceId: "service-2" })
    expect(svc.state.reqs).toHaveLength(2)
  }, 60_000)

  it("allows retry when the prepared callback is missing", async () => {
    const root = await repo()
    const svc = setup({ callback: false })

    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject<Partial<CloudUploadError>>({
      code: "prepared_missing",
      serviceId: "service-1",
    })
    const exp = path.join(root, ".testagent", "cloud", "export")
    expect(await readInfo(root)).toEqual({ serviceIds: [] })
    expect(await fs.readdir(exp)).toHaveLength(1)
    /* testagent_change start - previous retained-lease expectation kept for reference
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, reason: "service_unconfirmed" })
    testagent_change end */
    const next = retry(svc, { callbackId: "service-2", responseId: "service-2" })
    await expect(next.upload(root, "ses_1", root, ui())).resolves.toMatchObject({ serviceId: "service-2" })
    expect(svc.state.reqs).toHaveLength(2)
  }, 60_000)

  it("allows retry after container initialization fails", async () => {
    const root = await repo()
    const svc = setup({ initFail: true })

    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject<Partial<CloudUploadError>>({
      code: "initialization_failed",
      message: "码云容器初始化失败，归档已保留，可以重试",
    })
    const exp = path.join(root, ".testagent", "cloud", "export")
    expect(await readInfo(root)).toEqual({ serviceIds: [] })
    expect(await fs.readdir(exp)).toHaveLength(1)
    expect(svc.state.deleted).toEqual([])
    /* testagent_change start - previous retained-lease expectation kept for reference
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, reason: "service_unconfirmed" })
    testagent_change end */
    const next = retry(svc, { callbackId: "service-2", responseId: "service-2" })
    await expect(next.upload(root, "ses_1", root, ui())).resolves.toMatchObject({ serviceId: "service-2" })
    expect(svc.state.reqs).toHaveLength(2)
  }, 60_000)

  it("allows retry when createContainer returns no service ID", async () => {
    const root = await repo()
    const svc = setup({ responseId: "" })

    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject<Partial<CloudUploadError>>({
      code: "prepared_missing",
    })
    const workspace = await ensureCloudWorkspace(root)
    expect(await readCloudInfo(root)).toEqual({ serviceIds: [] })
    expect(await fs.readdir(workspace.export)).toHaveLength(1)
    /* testagent_change start - previous retained-lease expectation kept for reference
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, reason: "service_unconfirmed" })
    testagent_change end */
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: true })
    const next = retry(svc, { callbackId: "service-2", responseId: "service-2" })
    await expect(next.upload(root, "ses_1", root, ui())).resolves.toMatchObject({ serviceId: "service-2" })
    expect(svc.state.reqs).toHaveLength(2)
  }, 20_000)

  it("disables repeats while an upload is pending", async () => {
    const root = await repo()
    const gate = deferred()
    const started = deferred()
    const svc = setup({ wait: gate.promise, onSync: started.release })
    const first = svc.upload.upload(root, "ses_1", root, ui())

    await started.promise
    expect(await svc.upload.state(root, root)).toMatchObject({ enabled: false, pending: true, reason: "pending" })
    await expect(svc.upload.upload(root, "ses_1", root, ui())).rejects.toMatchObject<Partial<CloudUploadError>>({
      code: "pending",
    })
    gate.release()
    await first
    expect(svc.state.reqs).toHaveLength(1)
  }, 20_000)
})
