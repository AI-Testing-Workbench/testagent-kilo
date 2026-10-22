// testagent_change - new file: verify appending local archives through the public sandbox sync API
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import type { SessionArchive } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import type { CloudGitItem, CloudGitQuickPickOptions } from "../../src/testagent/cloud/git-preflight"
import { CloudHistory } from "../../src/testagent/cloud/history"
import type { ContainerFileSyncResult, RemoteSshApi } from "../../src/testagent/cloud/ssh-api"
import { writeCloudInfo } from "../../src/testagent/cloud/workspace"

const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

function archive(): SessionArchive {
  return {
    info: { id: "ses_1", directory: "unused", title: "Test", time: { created: 1, updated: 2 } },
    messages: [{ info: { id: "msg_1" }, parts: [{ id: "prt_1", type: "text", text: "archive data" }] }],
  }
}

async function setup(
  opts: {
    choose?: boolean
    fail?: boolean
    noInfo?: boolean
    type?: string
    services?: Array<{ id: string; expires?: string | null }>
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-append-"))
  roots.push(root)
  await simpleGit(root).raw(["init", "-b", "main"])
  const services = opts.services ?? [{ id: "service-1", expires: new Date(Date.now() + 3_600_000).toISOString() }]
  if (!opts.noInfo) await writeCloudInfo(root, { serviceIds: services.map((item) => item.id) })
  let exports = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      exports++
      return Response.json(archive())
    },
  })
  servers.push(server)
  const syncs: Array<{ source: string; target: string; conflict: string; mirror: boolean; content: string }> = []
  const state = { creates: 0 }
  const rem: RemoteSshApi = {
    revealSidebar: async () => undefined,
    createContainer: async () => {
      state.creates++
      return { service_id: "unexpected", status: "running" }
    },
    getContainer: async (serviceId) => ({
      service_id: serviceId,
      status: "running",
      type: opts.type ?? "testagent_cloud",
      name: "Development",
      expires_at: services.find((item) => item.id === serviceId)?.expires,
      gitee_user: "alice",
      gitee_repository: "repo",
      gitee_url: "https://github.com",
      gitee_branch: "main",
    }),
    syncFiles: async (source, target, conflict, mirror) => {
      syncs.push({ source, target, conflict, mirror, content: await fs.readFile(source, "utf8") })
      if (opts.fail) throw new Error("transfer failed")
      const result: ContainerFileSyncResult = {
        direction: "upload",
        copied: 1,
        skipped: 0,
        deleted: 0,
        bytesTransferred: 1,
        complete: true,
      }
      return result
    },
    deleteContainer: async () => undefined,
  }
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const items: CloudGitItem[][] = []
  const picks: CloudGitQuickPickOptions[] = []
  const errors: unknown[] = []
  const messages: unknown[] = []
  const notices: string[] = []
  const history = new CloudHistory({
    connection: {
      getClientAsync: async () => undefined,
      getServerConfig: () => ({ baseUrl: server.url.origin, password: "test" }),
    },
    registry: reg,
    dir: () => root,
    sessionDir: async () => root,
    context: (directory) => ({ directory }),
    pluginId: "test-tech.TestAgent",
    ui: {
      pick: async (list, pick) => {
        items.push([...list])
        picks.push(pick)
        return opts.choose === false ? undefined : list[0]
      },
      confirm: async () => undefined,
      modal: async (message) => notices.push(message),
    },
    remote: async () => rem,
    post: (message) => messages.push(message),
    onError: (err) => errors.push(err),
    success: (message) => notices.push(message),
  })
  return { root, history, items, picks, syncs, state, errors, exports: () => exports, messages, notices }
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("append session to an existing cloud sandbox", () => {
  it("always opens the picker and syncs the archive into the selected service repository", async () => {
    const svc = await setup()

    await svc.history.upload("ses_1", true)

    expect(svc.items).toHaveLength(1)
    expect(svc.items[0]).toEqual([expect.objectContaining({ id: "service-1", label: "Development (TestAgentCloud)" })])
    expect(svc.items[0]?.[0]?.detail).toMatch(/^服务剩余时间：/)
    expect(svc.picks[0]).toMatchObject({ ignoreFocusOut: true, matchOnDetail: true })
    expect(svc.exports()).toBe(1)
    expect(svc.syncs).toHaveLength(1)
    expect(svc.syncs[0]).toMatchObject({
      target: expect.stringMatching(/^service-1:\/app\/repo\/.testagent\/cloud\/import\/.*\.json$/),
      conflict: "overwrite",
      mirror: false,
      content: expect.stringContaining('"id": "ses_1"'),
    })
    expect(svc.state.creates).toBe(0)
    expect(await fs.readdir(path.join(svc.root, ".testagent", "cloud", "export"))).toEqual([])
    expect(svc.errors).toEqual([])
  }, 30_000)

  it("uses the Remote SSH description for automation sandboxes", async () => {
    const svc = await setup({ type: "autotest_cloud" })

    await svc.history.append("ses_1")

    expect(svc.items[0]?.[0]?.label).toBe("Development (自动化跑批)")
  }, 30_000)

  it("does not expose unknown service type identifiers", async () => {
    const svc = await setup({ type: "private_internal_type" })

    await svc.history.append("ses_1")

    expect(svc.items[0]?.[0]?.label).toBe("Development (未知类型)")
  }, 30_000)

  it("orders services by remaining time, longest first, with unknown expiry last", async () => {
    const now = Date.now()
    const svc = await setup({
      services: [
        { id: "short", expires: new Date(now + 3_600_000).toISOString() },
        { id: "unknown", expires: null },
        { id: "long", expires: new Date(now + 86_400_000).toISOString() },
      ],
    })

    await svc.history.append("ses_1")

    expect(svc.items[0]?.map((item) => item.id)).toEqual(["long", "short", "unknown"])
  }, 30_000)

  it("does not export or transfer when the service picker is cancelled", async () => {
    const svc = await setup({ choose: false })

    await svc.history.append("ses_1")

    expect(svc.items).toHaveLength(1)
    expect(svc.exports()).toBe(0)
    expect(svc.syncs).toEqual([])
    expect(svc.errors).toEqual([])
  }, 30_000)

  it("keeps the local archive when the selected service transfer fails", async () => {
    const svc = await setup({ fail: true })

    await svc.history.append("ses_1")

    expect(svc.errors).toHaveLength(1)
    expect(svc.syncs).toHaveLength(1)
    expect(await fs.readdir(path.join(svc.root, ".testagent", "cloud", "export"))).toHaveLength(1)
  }, 30_000)

  it("reports no append action without creating info.json", async () => {
    const svc = await setup({ noInfo: true })

    await svc.history.availability()

    expect(svc.messages).toContainEqual({ type: "cloudAppendAvailability", available: false })
    await expect(fs.access(path.join(svc.root, ".testagent", "cloud", "info.json"))).rejects.toThrow()
  }, 30_000)
})
