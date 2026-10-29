// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import {
  CLOUD_SYNC_HEARTBEAT_MS,
  CLOUD_SYNC_INTERVAL_MS,
  CLOUD_SYNC_LEASE_MS,
  CloudWorkspaceBusyError,
  WorkspaceSyncRegistry,
  WorkspaceSyncCoordinator,
  type CloudCoordinatorOptions,
} from "../../src/testagent/cloud/coordinator"
import { ensureCloudWorkspace } from "../../src/testagent/cloud/workspace"

const roots: string[] = []
const regs: WorkspaceSyncRegistry[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-coordinator-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.addRemote("origin", "https://github.com/test/repo.git")
  return root
}

function opts(values: Partial<CloudCoordinatorOptions> = {}): CloudCoordinatorOptions {
  return { onError: () => undefined, ...values }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(async () => {
  await Promise.all(regs.splice(0).map((reg) => reg.dispose()))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("码云仓库工作区协调器", () => {
  it("使用 5 秒调度周期及租约默认值", () => {
    expect(CLOUD_SYNC_INTERVAL_MS).toBe(5_000)
    expect(CLOUD_SYNC_HEARTBEAT_MS).toBe(5_000)
    expect(CLOUD_SYNC_LEASE_MS).toBe(15_000)
  })

  it("并发注册同一调度器时只启动一个 poller", async () => {
    const root = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const coord = await reg.get(root, opts({ intervalMs: 15, heartbeatMs: 100, leaseMs: 2_000 }))
    const state = { count: 0 }
    const task = async () => {
      state.count++
      await wait(20)
    }

    expect(await Promise.all([coord.start(task), coord.start(task)])).toEqual([true, false])
    await wait(80)
    await coord.dispose()
    expect(state.count).toBeGreaterThan(1)
  }, 15_000)

  it("每个本地码云仓库只注册一个协调器且多仓库互相隔离", async () => {
    const root = await repo()
    const sub = path.join(root, "nested")
    await fs.mkdir(sub)
    const next = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)

    const first = await reg.get(root, opts())
    const same = await reg.get(sub, opts())
    const other = await reg.get(next, opts())

    expect(same).toBe(first)
    expect(other).not.toBe(first)
  }, 15_000)

  it("跨窗口只允许一个 owner，释放后可接管租约", async () => {
    const root = await repo()
    const one = new WorkspaceSyncRegistry()
    const two = new WorkspaceSyncRegistry()
    regs.push(one, two)
    const first = await one.get(root, opts())
    const second = await two.get(root, opts())
    expect(first).toBeInstanceOf(WorkspaceSyncCoordinator)

    expect(await first.start(async () => undefined)).toBe(true)
    expect(await first.start(async () => undefined)).toBe(false)
    expect(await second.start(async () => undefined)).toBe(false)
    await expect(second.run(async () => undefined)).rejects.toBeInstanceOf(CloudWorkspaceBusyError)

    await first.dispose()
    expect(await second.start(async () => undefined)).toBe(true)
    const lock = await ensureCloudWorkspace(root).then((workspace) => workspace.lock)
    const value = JSON.parse(await fs.readFile(lock, "utf8"))
    expect(Object.keys(value).sort()).toEqual(["heartbeat", "owner"])
    await second.dispose()
    expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined()
  }, 15_000)

  it("清理未确认时保留租约并阻止其他窗口操作", async () => {
    const root = await repo()
    const one = new WorkspaceSyncRegistry()
    const two = new WorkspaceSyncRegistry()
    regs.push(one, two)
    const first = await one.get(root, opts())
    const second = await two.get(root, opts())

    expect(await first.run(async () => first.retain())).toBe(true)
    await expect(second.run(async () => undefined)).rejects.toBeInstanceOf(CloudWorkspaceBusyError)
    await first.releaseRetained()
    expect(await second.run(async () => "available")).toBe("available")
  }, 15_000)

  it("回收过期租约", async () => {
    const root = await repo()
    const workspace = await ensureCloudWorkspace(root)
    const old = Date.now() - 1_000
    await fs.writeFile(workspace.lock, JSON.stringify({ owner: "dead-window", heartbeat: old }))
    await fs.utimes(workspace.lock, old / 1_000, old / 1_000)

    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const coord = await reg.get(root, opts({ leaseMs: 50, heartbeatMs: 10 }))

    expect(await coord.start(async () => undefined)).toBe(true)
    expect(JSON.parse(await fs.readFile(workspace.lock, "utf8")).owner).not.toBe("dead-window")
  }, 15_000)

  it("串行执行排队的 UI 操作并在失败后继续处理", async () => {
    const root = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const coord = await reg.get(root, opts())
    const order: string[] = []

    const fail = coord.run(async () => {
      order.push("first")
      throw new Error("expected failure")
    })
    const next = coord.run(async () => {
      order.push("second")
      return "ok"
    })

    await expect(fail).rejects.toThrow("expected failure")
    expect(await next).toBe("ok")
    expect(order).toEqual(["first", "second"])
  }, 15_000)

  it("调度周期不重叠并可正常停止", async () => {
    const root = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const coord = await reg.get(root, opts({ intervalMs: 15, heartbeatMs: 100, leaseMs: 2_000 }))
    const state = { count: 0, active: 0, peak: 0 }

    expect(
      await coord.start(async () => {
        state.count++
        state.active++
        state.peak = Math.max(state.peak, state.active)
        await wait(40)
        state.active--
      }),
    ).toBe(true)
    const lock = (await ensureCloudWorkspace(root)).lock
    const first = JSON.parse(await fs.readFile(lock, "utf8")).heartbeat
    await wait(125)
    expect(JSON.parse(await fs.readFile(lock, "utf8")).heartbeat).toBeGreaterThan(first)
    await coord.dispose()

    expect(state.count).toBeGreaterThan(1)
    expect(state.peak).toBe(1)
    expect(await fs.stat(lock).catch(() => undefined)).toBeUndefined()
  }, 15_000)

  it("不同本地码云仓库分别运行调度器", async () => {
    const root = await repo()
    const next = await repo()
    const reg = new WorkspaceSyncRegistry()
    regs.push(reg)
    const first = await reg.get(root, opts())
    const second = await reg.get(next, opts())

    expect(await Promise.all([first.start(async () => undefined), second.start(async () => undefined)])).toEqual([
      true,
      true,
    ])
  }, 15_000)
})
