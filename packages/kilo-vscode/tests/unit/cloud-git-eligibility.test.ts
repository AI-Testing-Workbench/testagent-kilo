// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import { CloudHistory } from "../../src/testagent/cloud/history"
import type { CoreArchiveConnection } from "../../src/testagent/cloud/archive-api"
import { WorkspaceSyncRegistry } from "../../src/testagent/cloud/coordinator"
import {
  selectCloudGitTargetInQueue,
  type CloudGitItem,
  type CloudGitUi,
} from "../../src/testagent/cloud/git-preflight"
import { CloudUploadService } from "../../src/testagent/cloud/upload"

const roots: string[] = []
const regs: WorkspaceSyncRegistry[] = []

async function repo(url?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-git-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "initial\n")
  await git.add("README.md")
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  if (url) await git.addRemote("origin", url)
  return root
}

function conn(): CoreArchiveConnection {
  return {
    getClientAsync: async () => undefined,
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:1", password: "test" }),
  }
}

function ui(modals: string[] = []): CloudGitUi {
  return {
    pick: async (items: readonly CloudGitItem[]) => items.find((item) => item.label === "main"),
    confirm: async () => "取消",
    modal: async (message) => {
      modals.push(message)
    },
  }
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("码云仓库上云入口", () => {
  it("接受 HTTP(S) remote 且没有 tracking refs 时模态提示本地分支未推送", async () => {
    const root = await repo("https://token:secret@github.com/alice/repo.git")
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const modals: string[] = []
    const service = new CloudUploadService({
      connection: conn(),
      registry: reg,
      pluginId: "test-tech.TestAgent",
      onError: () => undefined,
    })

    expect(await service.state(root, root)).toMatchObject({ enabled: true, root })
    expect(await selectCloudGitTargetInQueue(root, ui(modals))).toBeUndefined()
    expect(modals).toEqual([
      "所选码云仓库远端 origin 没有可选择的分支。本地分支 main 尚未推送至该远端。请先将分支推送至该远端后重试。",
    ])
  }, 30_000)

  it("按钮请求遇到不支持状态时只记录错误，不向历史列表发提示", async () => {
    const root = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const errors: string[] = []
    const messages: Array<{ type: string; error?: string }> = []
    const history = new CloudHistory({
      connection: conn(),
      registry: reg,
      dir: () => root,
      sessionDir: async () => root,
      context: (directory) => ({ directory }),
      pluginId: "test-tech.TestAgent",
      ui: ui(),
      post: (message) => messages.push(message),
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    })

    await history.upload("ses_1")

    expect(errors).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ type: "cloudActionProgress", action: "upload", pending: false })
  }, 30_000)

  it("SSH remote 不支持时只记录错误，不向历史列表发提示", async () => {
    const root = await repo("git@github.com:alice/repo.git")
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const errors: string[] = []
    const history = new CloudHistory({
      connection: conn(),
      registry: reg,
      dir: () => root,
      sessionDir: async () => root,
      context: (directory) => ({ directory }),
      pluginId: "test-tech.TestAgent",
      ui: ui(),
      post: () => undefined,
      onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
    })

    await history.upload("ses_1")

    expect(errors).toHaveLength(1)
  }, 30_000)
})
