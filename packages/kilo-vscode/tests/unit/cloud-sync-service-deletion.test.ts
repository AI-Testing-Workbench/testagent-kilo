// testagent_change - new file: verify deleted bindings are removed while stopped services remain bound
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CoreArchiveApi } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudArchiveSyncService } from "../../src/testagent/cloud/sync-service"
import type { RemoteSshApi } from "../../src/testagent/cloud/remote-api"
import { ensureCloudWorkspace, readCloudInfo, writeCloudInfo } from "../../src/testagent/cloud/workspace"

const roots: string[] = []
const syncs: CloudArchiveSyncService[] = []
const regs: WorkspaceSyncRegistry[] = []
const issues: unknown[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-service-deletion-"))
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

function remote(getContainer: RemoteSshApi["getContainer"], state: { sync: number }): RemoteSshApi {
  return {
    revealSidebar: async () => undefined,
    createContainer: async () => ({ service_id: "unused", status: "running" }),
    getContainer,
    syncFiles: async () => {
      state.sync++
      return { direction: "download", copied: 0, skipped: 0, deleted: 0, bytesTransferred: 0, complete: true }
    },
    deleteContainer: async () => undefined,
  }
}

async function waitFor(test: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 3_000
  while (Date.now() < end) {
    if (await test()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("等待码云服务轮询超时")
}

function start(root: string, api: RemoteSshApi) {
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const sync = new CloudArchiveSyncService({
    mode: "local",
    registry: reg,
    archive: new CoreArchiveApi({ connect: async () => undefined, config: () => null }),
    remote: async () => api,
    intervalMs: 20,
    heartbeatMs: 100,
    leaseMs: 2_000,
    onError: (err) => issues.push(err),
  })
  syncs.push(sync)
  return sync.refresh(root)
}

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.dispose()))
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("clears not-found service IDs and keeps stopped services", async () => {
  const root = await repo()
  const workspace = await ensureCloudWorkspace(root)
  await writeCloudInfo(root, { serviceIds: ["deleted-service"] })
  const lost = { checks: 0, sync: 0 }
  const gone = remote(async () => {
    lost.checks++
    throw Object.assign(new Error("not found"), { code: "http_error", statusCode: 404 })
  }, lost)

  expect(await start(root, gone)).toBe(true)
  await waitFor(async () => (await readCloudInfo(root)).serviceIds.length === 0)
  expect(lost.checks).toBeGreaterThanOrEqual(1)
  expect(lost.sync).toBe(0)
  expect(await fs.readFile(workspace.info, "utf8")).toContain('"serviceIds": []')
  await syncs[0]?.dispose()

  const next = await repo()
  await ensureCloudWorkspace(next)
  await writeCloudInfo(next, { serviceIds: ["stopped-service"] })
  const stopped = { checks: 0, sync: 0 }
  const sleeping = remote(async (serviceId) => {
    stopped.checks++
    return {
      service_id: serviceId,
      status: "stopped",
      gitee_user: "alice",
      gitee_repository: "repo",
    }
  }, stopped)

  expect(await start(next, sleeping)).toBe(true)
  await waitFor(async () => stopped.checks > 0)
  expect(issues).toEqual([])
  expect((await readCloudInfo(next)).serviceIds).toEqual(["stopped-service"])
  expect(stopped.sync).toBe(0)
}, 60_000)
