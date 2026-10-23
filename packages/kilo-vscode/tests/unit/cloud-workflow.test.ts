// testagent_change - new file: verify dirty-workspace upload decisions across the real archive service
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import type { SessionArchive } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import type { CloudGitItem, CloudGitQuickPickOptions, CloudGitUi } from "../../src/testagent/cloud/git-preflight"
import { CloudUploadService } from "../../src/testagent/cloud/upload"
import type {
  ContainerConfigEntry,
  ContainerCreateRequest,
  ContainerFileSyncResult,
  RemoteSshApi,
} from "../../src/testagent/cloud/remote-api"

const dirs: string[] = []
const hosts: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-workflow-"))
  dirs.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "committed source\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")
  const hash = await git.revparse("HEAD")
  await git.raw(["update-ref", "refs/remotes/origin/main", hash])
  await git.raw(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
  return root
}

function data(): SessionArchive {
  return {
    info: { id: "ses_dirty", directory: "unused", title: "Committed session", time: { created: 1, updated: 2 } },
    messages: [{ info: { id: "msg_1" }, parts: [{ id: "part_1", type: "text", text: "archive only" }] }],
  }
}

function ui(confirm: string): CloudGitUi {
  return {
    pick: async (items: readonly CloudGitItem[], _opts: CloudGitQuickPickOptions) =>
      items.find((item) => item.label === "main"),
    confirm: async () => confirm,
    modal: async () => undefined,
  }
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("Cloud upload workflow", () => {
  it("cancels dirty uploads or sends only the selected committed branch archive", async () => {
    const root = await repo()
    await fs.writeFile(path.join(root, "uncommitted.txt"), "local-only")
    const host = Bun.serve({ port: 0, fetch: () => Response.json(data()) })
    hosts.push(host)
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const reqs: ContainerCreateRequest[] = []
    const syncs: Array<{ source: string; target: string }> = []
    const body: string[] = []
    const remote: RemoteSshApi = {
      revealSidebar: async () => undefined,
      createContainer: async (req) => {
        reqs.push(req)
        await req.callbacks.containerPrepared({ serviceId: "service_1", host: "container" })
        return { service_id: "service_1", status: "running" }
      },
      getContainer: async () => ({
        service_id: "service_1",
        status: "running",
        gitee_user: "alice",
        gitee_repository: "repo",
      }),
      syncFiles: async (source, target) => {
        syncs.push({ source, target })
        body.push(await fs.readFile(source, "utf8"))
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
    const service = new CloudUploadService({
      connection: {
        getClientAsync: async () => undefined,
        getServerConfig: () => ({ baseUrl: host.url.origin, password: "secret" }),
      },
      registry: reg,
      remote: async () => remote,
      pluginId: "test-tech.TestAgent",
      onError: (err) => {
        throw err
      },
    })

    expect(await service.upload(root, "ses_dirty", root, ui("取消"))).toBeUndefined()
    expect(reqs).toHaveLength(0)
    expect(syncs).toHaveLength(0)

    const result = await service.upload(root, "ses_dirty", root, ui("仅使用码云仓库已提交版本"))
    expect(result?.serviceId).toBe("service_1")
    expect(reqs[0]?.gitee_branch).toBe("main")
    expect(syncs[0]?.source).toContain(path.join(".testagent", "cloud", "export"))
    expect(syncs[0]?.source).not.toContain("uncommitted.txt")
    expect(body[0]).toContain("archive only")
    expect(body[0]).not.toContain("local-only")
  }, 60_000)
})
