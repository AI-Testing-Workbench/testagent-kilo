// testagent_change - new file: remove only empty directories for unbound imported services
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CoreArchiveApi } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudArchiveSyncService, type CloudSyncIssue } from "../../src/testagent/cloud/sync-service"
import type { RemoteSshApi } from "../../src/testagent/cloud/remote-api"
import { ensureCloudWorkspace, readCloudInfo, writeCloudInfo } from "../../src/testagent/cloud/workspace"

const roots: string[] = []
const syncs: CloudArchiveSyncService[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-service-cleanup-"))
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

async function waitFor(test: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 3_000
  while (Date.now() < end) {
    if (await test()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("等待已删除服务的本地目录清理超时")
}

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("deletes empty directories for unbound service IDs and preserves nonempty ones", async () => {
  const root = await repo()
  const workspace = await ensureCloudWorkspace(root)
  await writeCloudInfo(root, { serviceIds: [] })
  const gone = path.join(workspace.import, "service-gone")
  const full = path.join(workspace.import, "service-old-full")
  const old = path.join(workspace.import, "service-old")
  await Promise.all([gone, full, old].map((dir) => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(path.join(full, "archive.json"), "keep")

  const issues: CloudSyncIssue[] = []
  const registry = new WorkspaceSyncRegistry()
  const sync = new CloudArchiveSyncService({
    mode: "local",
    registry,
    archive: new CoreArchiveApi({
      connect: async () => undefined,
      config: () => null,
    }),
    remote: async () => {
      throw new Error("不会请求 Remote SSH")
    },
    intervalMs: 20,
    heartbeatMs: 100,
    leaseMs: 2_000,
    onError: (issue) => issues.push(issue),
  })
  syncs.push(sync)

  expect(await sync.refresh(root)).toBe(false)
  await sync.dispose()

  expect((await fs.readdir(workspace.import)).sort()).toEqual(["service-old-full"])
  expect(await fs.readFile(path.join(full, "archive.json"), "utf8")).toBe("keep")
  expect(
    await fs.stat(gone).then(
      () => false,
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    ),
  ).toBe(true)
  expect(
    await fs.stat(old).then(
      () => false,
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    ),
  ).toBe(true)
  expect(issues).toEqual([])
}, 30_000)

it("removes an empty service directory in the scheduler cycle that unbinds it", async () => {
  const root = await repo()
  const workspace = await ensureCloudWorkspace(root)
  await writeCloudInfo(root, { serviceIds: ["service-gone"] })
  const dir = path.join(workspace.import, "service-gone")
  await fs.mkdir(dir, { recursive: true })

  const remote: RemoteSshApi = {
    revealSidebar: async () => undefined,
    createContainer: async () => ({ service_id: "unused", status: "running" }),
    getContainer: async (id) => ({
      service_id: id,
      status: "deleted",
      gitee_user: "alice",
      gitee_repository: "repo",
    }),
    syncFiles: async () => ({
      direction: "download",
      copied: 0,
      skipped: 0,
      deleted: 0,
      bytesTransferred: 0,
      complete: true,
    }),
    deleteContainer: async () => undefined,
  }
  const sync = new CloudArchiveSyncService({
    mode: "local",
    registry: new WorkspaceSyncRegistry(),
    archive: new CoreArchiveApi({ connect: async () => undefined, config: () => null }),
    remote: async () => remote,
    intervalMs: 20,
    heartbeatMs: 100,
    leaseMs: 2_000,
    onError: () => undefined,
  })
  syncs.push(sync)

  expect(await sync.refresh(root)).toBe(true)
  await waitFor(async () =>
    fs.stat(dir).then(
      () => false,
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    ),
  )
  await sync.dispose()

  expect((await readCloudInfo(root)).serviceIds).toEqual([])
  expect(await fs.readdir(workspace.import)).toEqual([])
}, 30_000)
