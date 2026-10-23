// testagent_change - new file: verify destination directory remapping preserves content-hash archive names
import { afterEach, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CoreArchiveApi } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudArchiveSyncService } from "../../src/testagent/cloud/sync-service"

const roots: string[] = []
const hosts: Array<ReturnType<typeof Bun.serve>> = []
const syncs: CloudArchiveSyncService[] = []
const regs: WorkspaceSyncRegistry[] = []

async function waitFor(test: () => boolean): Promise<void> {
  const end = Date.now() + 3_000
  while (Date.now() < end) {
    if (test()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("等待归档导入超时")
}

afterEach(async () => {
  await Promise.all(syncs.splice(0).map((sync) => sync.dispose()))
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("maps archive project metadata at import time without rewriting the SCP file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-project-path-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")

  const archive = {
    info: {
      id: "ses_path",
      title: "Nested session",
      projectID: "source-project",
      directory: "/source/repo/packages/app",
      path: "packages\\app",
      time: { created: 1, updated: 2 },
    },
    messages: [],
  }
  const raw = `${JSON.stringify(archive, null, 2)}\n`
  const sid = createHash("sha256").update(archive.info.id).digest("hex").slice(0, 16)
  const rev = createHash("sha256").update(raw).digest("hex").slice(0, 16)
  const name = `${sid}-${rev}.json`
  const file = path.join(root, ".testagent", "cloud", "import", "service-1", name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, raw)

  const requests: Array<{ body: unknown; source: string; name: string }> = []
  const state = { imported: false }
  const host = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push({ body: await req.json(), source: await fs.readFile(file, "utf8"), name })
      return Response.json({ sourceSessionID: "ses_path", sessionID: "ses_path", forked: false })
    },
  })
  hosts.push(host)
  const reg = new WorkspaceSyncRegistry()
  regs.push(reg)
  const archiveApi = new CoreArchiveApi({
    connect: async () => undefined,
    config: () => ({ baseUrl: host.url.origin, password: "secret" }),
  })
  const sync = new CloudArchiveSyncService({
    mode: "cloud",
    registry: reg,
    archive: archiveApi,
    remote: async () => {
      throw new Error("cloud import must not call Remote SSH")
    },
    context: (directory) => ({ directory }),
    intervalMs: 20,
    heartbeatMs: 100,
    leaseMs: 2_000,
    onImported: () => {
      state.imported = true
    },
    onError: (issue) => {
      throw issue
    },
  })
  syncs.push(sync)

  expect(await sync.refresh(root)).toBe(true)
  await waitFor(() => requests.length > 0)
  await sync.dispose()

  expect(requests).toHaveLength(1)
  expect(requests[0]?.name).toBe(name)
  expect(requests[0]?.source).toBe(raw)
  expect(state.imported).toBe(true)
  expect(requests[0]?.body).toMatchObject({
    info: {
      id: "ses_path",
      projectID: "source-project",
      directory: root,
      path: "packages/app",
    },
  })
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
}, 30_000)
