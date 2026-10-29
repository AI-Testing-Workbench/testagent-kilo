// testagent_change - new file: verify local history availability for unsupported workspaces
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git" // testagent_change
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudHistory } from "../../src/testagent/cloud/history"

const roots: string[] = []
const regs: WorkspaceSyncRegistry[] = []

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("Cloud history availability", () => {
  it("hides unsupported repositories and exposes supported HTTP(S) repositories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-history-availability-"))
    roots.push(root)
    // testagent_change start - model a Git workspace without a supported HTTP(S) remote
    const git = simpleGit(root)
    await git.init()
    await git.raw(["symbolic-ref", "HEAD", "refs/heads/main"])
    await git.addRemote("origin", "git@github.com:alice/repo.git")
    // testagent_change end
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const messages: unknown[] = []
    const errors: unknown[] = []
    const history = new CloudHistory({
      connection: {
        getClientAsync: async () => undefined,
        getServerConfig: () => ({ baseUrl: "http://127.0.0.1:1", password: "test" }),
      },
      registry: reg,
      dir: () => root,
      sessionDir: async () => root,
      context: (directory) => ({ directory }),
      pluginId: "test-tech.TestAgent",
      ui: { pick: async () => undefined, confirm: async () => undefined },
      post: (message) => messages.push(message),
      onError: (err) => errors.push(err),
    })

    await history.availability()
    await history.list()

    expect(messages).toContainEqual({ type: "cloudArchiveAvailability", available: false })
    expect(messages).toContainEqual({ type: "cloudArchiveListLoaded", archives: [], invalidCount: 0 })
    expect(errors).toEqual([])

    // testagent_change start - retain Cloud history for a supported HTTP(S) repository
    await git.raw(["remote", "set-url", "origin", "https://github.com/alice/repo.git"])
    await history.availability()
    expect(messages.at(-1)).toEqual({ type: "cloudArchiveAvailability", available: true })
    // testagent_change end
  }, 30_000)
})
