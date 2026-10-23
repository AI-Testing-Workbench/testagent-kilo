// testagent_change - new file: verify missing remotes leave Cloud history visible and fail on list request
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import { CloudHistory } from "../../src/testagent/cloud/history"

const roots: string[] = []
const regs: WorkspaceSyncRegistry[] = []

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("keeps Cloud history available without a remote and reports the list error on request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-history-no-remote-"))
  roots.push(root)
  await simpleGit(root).raw(["init", "-b", "main"])
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
  await expect(history.list()).rejects.toMatchObject({ code: "workspace_error", detail: { code: "no_remote" } })

  expect(messages).toContainEqual({ type: "cloudArchiveAvailability", available: true })
  expect(messages).toContainEqual({ type: "cloudArchiveOperationFailed", operation: "list", key: undefined })
  expect(errors).toHaveLength(1)
}, 30_000)
