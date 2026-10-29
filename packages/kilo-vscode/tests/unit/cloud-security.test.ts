// testagent_change - new file: reject archive symlink traversal and invalid timestamps
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { createCoreArchiveApi } from "../../src/testagent/cloud/archive-api"
import { CloudArchiveDataError, cloudArchiveData } from "../../src/testagent/cloud/archive-data"
import { CloudArchiveFiles, CloudArchiveFilesError } from "../../src/testagent/cloud/archive-files"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { ensureCloudWorkspace } from "../../src/testagent/cloud/workspace"

const dirs: string[] = []
const hosts: Array<ReturnType<typeof Bun.serve>> = []
const regs: WorkspaceSyncRegistry[] = []

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-security-"))
  dirs.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  await git.addRemote("origin", "https://github.com/alice/repo.git")
  const hash = await git.revparse("HEAD")
  await git.raw(["update-ref", "refs/remotes/origin/main", hash])
  await git.raw(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
  return root
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("Cloud archive path validation", () => {
  it("rejects reads and forks through a symlinked import ancestor", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-outside-"))
    dirs.push(outside)
    await fs.writeFile(path.join(outside, "escaped.json"), "{}")
    await fs.symlink(outside, path.join(workspace.import, "alias"), process.platform === "win32" ? "junction" : "dir")
    const calls: string[] = []
    const host = Bun.serve({
      port: 0,
      fetch: (req) => {
        calls.push(req.url)
        return Response.json({ sourceSessionID: "outside", sessionID: "forked", forked: true })
      },
    })
    hosts.push(host)
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const files = new CloudArchiveFiles({
      archive: createCoreArchiveApi({
        getClientAsync: async () => undefined,
        getServerConfig: () => ({ baseUrl: host.url.origin, password: "secret" }),
      }),
      registry: reg,
      context: (directory) => ({ directory, workspace: "local-workspace" }),
      onError: (err) => {
        throw err
      },
    })

    expect(await files.list(root)).toEqual({ archives: [], invalidCount: 0 })
    await expect(files.read(root, "alias/escaped.json")).rejects.toMatchObject<Partial<CloudArchiveFilesError>>({
      code: "invalid_path",
    })
    await expect(files.fork(root, "alias/escaped.json")).rejects.toMatchObject<Partial<CloudArchiveFilesError>>({
      code: "invalid_path",
    })
    expect(calls).toEqual([])
  }, 60_000)

  it("rejects non-finite archive timestamps before formatting", () => {
    expect(() =>
      cloudArchiveData({
        info: {
          id: "ses_invalid_time",
          directory: "/repo",
          title: "Invalid time",
          version: "1.0.0",
          time: { created: 1e100, updated: 1 },
        },
        messages: [],
      }),
    ).toThrow(CloudArchiveDataError)
  })
})
