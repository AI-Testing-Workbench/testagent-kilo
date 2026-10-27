// testagent_change - new file
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { CloudWorkspaceError, ensureCloudWorkspace, type CloudWorkspace } from "./workspace"
import { writeAtomic } from "./atomic"

export const CLOUD_SYNC_INTERVAL_MS = 5_000
export const CLOUD_SYNC_HEARTBEAT_MS = 5_000
export const CLOUD_SYNC_LEASE_MS = 15_000

export type CloudCoordinatorOptions = {
  intervalMs?: number
  heartbeatMs?: number
  leaseMs?: number
  onError: (err: unknown) => void
}

export class CloudWorkspaceBusyError extends Error {
  constructor() {
    super("另一个工作台窗口正在同步此本地工作区码云仓库")
    this.name = "CloudWorkspaceBusyError"
  }
}

type LeaseInfo = { owner: string; heartbeat: number; mtime: number }

export class WorkspaceSyncCoordinator {
  private readonly lease: WorkspaceLease
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private starting: Promise<boolean> | undefined
  private polling = false
  private disposed = false
  private retained = false
  private readonly interval: number
  private readonly onError: (err: unknown) => void

  constructor(workspace: CloudWorkspace, opts: CloudCoordinatorOptions) {
    this.interval = opts.intervalMs ?? CLOUD_SYNC_INTERVAL_MS
    this.onError = opts.onError
    this.lease = new WorkspaceLease(
      workspace.lock,
      opts.leaseMs ?? CLOUD_SYNC_LEASE_MS,
      opts.heartbeatMs ?? CLOUD_SYNC_HEARTBEAT_MS,
      opts.onError,
    )
  }

  async start(task: () => Promise<void>): Promise<boolean> {
    if (this.disposed || this.timer) return false
    if (this.starting) return false
    const starting = this.begin(task)
    this.starting = starting
    return starting.finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
  }

  private async begin(task: () => Promise<void>): Promise<boolean> {
    if (this.disposed || this.timer) return false
    if (!(await this.lease.acquire())) return false
    if (this.disposed) {
      await this.lease.release()
      return false
    }
    this.timer = setInterval(() => void this.tick(task), this.interval)
    return true
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("本地工作区码云仓库的同步协调器已释放"))
    const current = this.queue.then(async () => {
      if (this.timer || this.retained) {
        if (!(await this.lease.owns())) throw new CloudWorkspaceBusyError()
        return task()
      }

      if (!(await this.lease.acquire())) throw new CloudWorkspaceBusyError()
      try {
        if (!(await this.lease.owns())) throw new CloudWorkspaceBusyError()
        return await task()
      } finally {
        if (!this.timer && !this.retained) await this.lease.release()
      }
    })
    // Keep the serial queue usable after a failed task while returning that failure to its caller.
    this.queue = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.starting) await this.starting
    await this.queue
    this.retained = false
    await this.lease.release()
  }

  async retain(): Promise<boolean> {
    if (this.disposed) return false
    if (!(await this.lease.acquire())) return false
    this.retained = true
    return true
  }

  async releaseRetained(): Promise<void> {
    if (this.timer || !this.retained) return
    this.retained = false
    await this.lease.release()
  }

  private async tick(task: () => Promise<void>): Promise<void> {
    if (this.disposed || this.polling) return
    this.polling = true
    try {
      await this.run(task)
    } catch (err) {
      this.onError(err)
      if (err instanceof CloudWorkspaceBusyError) {
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
      }
    } finally {
      this.polling = false
    }
  }
}

export class WorkspaceSyncRegistry {
  private readonly coordinators = new Map<string, WorkspaceSyncCoordinator>()

  async get(dir: string, opts: CloudCoordinatorOptions): Promise<WorkspaceSyncCoordinator> {
    const workspace = await ensureCloudWorkspace(dir)
    const key = process.platform === "win32" ? workspace.root.toLowerCase() : workspace.root
    const found = this.coordinators.get(key)
    if (found) return found
    const coordinator = new WorkspaceSyncCoordinator(workspace, opts)
    this.coordinators.set(key, coordinator)
    return coordinator
  }

  async dispose(): Promise<void> {
    const all = [...this.coordinators.values()]
    this.coordinators.clear()
    await Promise.all(all.map((coordinator) => coordinator.dispose()))
  }
}

class WorkspaceLease {
  private readonly owner = randomUUID()
  private timer: NodeJS.Timeout | undefined
  private held = false

  constructor(
    private readonly file: string,
    private readonly ttl: number,
    private readonly beat: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  async acquire(): Promise<boolean> {
    try {
      if (this.held && (await this.owns())) return true
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      return await this.attempt(3)
    } catch (err) {
      throw lockError(err)
    }
  }

  private async attempt(count: number): Promise<boolean> {
    if (count === 0) return false
    if (await this.create()) return true
    const state = await readLease(this.file)
    if (state?.owner === this.owner) {
      this.activate()
      return true
    }
    if (state && !stale(state, this.ttl)) return false
    return (await this.reclaim()) ? this.attempt(count - 1) : false
  }

  async owns(): Promise<boolean> {
    if (!this.held) return false
    try {
      const state = await readLease(this.file)
      if (state?.owner === this.owner) return true
      this.held = false
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      return false
    } catch (err) {
      throw lockError(err)
    }
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (!this.held) return
    this.held = false
    await withGuard(this.file, this.ttl, async () => {
      const state = await readLease(this.file)
      if (state?.owner === this.owner) await fs.rm(this.file, { force: true })
    }).catch((err) => {
      throw lockError(err)
    })
  }

  private async create(): Promise<boolean> {
    const handle = await fs.open(this.file, "wx").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return undefined
      throw err
    })
    if (!handle) return false
    try {
      await handle.writeFile(JSON.stringify({ owner: this.owner, heartbeat: Date.now() }))
      await handle.sync()
    } catch (err) {
      await handle.close()
      await fs.rm(this.file, { force: true })
      throw err
    }
    await handle.close()
    this.activate()
    return true
  }

  private async reclaim(): Promise<boolean> {
    return withGuard(this.file, this.ttl, async () => {
      const state = await readLease(this.file)
      if (!state) return true
      if (!stale(state, this.ttl)) return false
      const file = `${this.file}.${randomUUID()}.stale`
      await fs.rename(this.file, file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err
      })
      await fs.rm(file, { force: true })
      return true
    })
  }

  private activate(): void {
    if (this.held) return
    this.held = true
    this.timer = setInterval(() => void this.renew(), this.beat)
  }

  private async renew(): Promise<void> {
    if (!this.held) return
    try {
      const kept = await withGuard(this.file, this.ttl, async () => {
        const state = await readLease(this.file)
        if (state?.owner !== this.owner) return false
        await writeAtomic(this.file, JSON.stringify({ owner: this.owner, heartbeat: Date.now() }))
        return true
      })
      if (!kept) this.lose()
    } catch (err) {
      this.lose()
      this.onError(lockError(err))
    }
  }

  private lose(): void {
    this.held = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

async function readLease(file: string): Promise<LeaseInfo | undefined> {
  const stat = await fs.stat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined
    throw err
  })
  if (!stat) return undefined
  const raw = await fs.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return ""
    throw err
  })
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === "object" &&
      "owner" in value &&
      typeof value.owner === "string" &&
      "heartbeat" in value &&
      typeof value.heartbeat === "number"
    ) {
      return { owner: value.owner, heartbeat: value.heartbeat, mtime: stat.mtimeMs }
    }
  } catch {
    return { owner: "", heartbeat: 0, mtime: stat.mtimeMs }
  }
  return { owner: "", heartbeat: 0, mtime: stat.mtimeMs }
}

function stale(state: LeaseInfo, ttl: number): boolean {
  return Date.now() - (state.owner ? state.heartbeat : state.mtime) > ttl
}

async function withGuard<T>(file: string, ttl: number, task: () => Promise<T>): Promise<T> {
  const guard = `${file}.guard`
  const owner = randomUUID()
  await acquireGuard(guard, ttl, owner)

  try {
    return await task()
  } finally {
    const state = await readLease(guard)
    if (state?.owner === owner) await fs.rm(guard, { force: true })
  }
}

async function acquireGuard(guard: string, ttl: number, owner: string): Promise<void> {
  const start = Date.now()
  while (true) {
    const handle = await fs.open(guard, "wx").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") return undefined
      throw err
    })
    if (handle) {
      try {
        await handle.writeFile(JSON.stringify({ owner, heartbeat: Date.now() }))
        await handle.sync()
      } catch (err) {
        await handle.close()
        await fs.rm(guard, { force: true })
        throw err
      }
      await handle.close()
      return
    }

    const state = await readLease(guard)
    if (state && stale(state, ttl)) {
      const old = `${guard}.${randomUUID()}.stale`
      await fs.rename(guard, old).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err
      })
      await fs.rm(old, { force: true })
      continue
    }
    if (Date.now() - start > ttl * 2) throw new Error("等待本地工作区码云仓库的租约锁超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const cloudSyncRegistry = new WorkspaceSyncRegistry()

function lockError(err: unknown): CloudWorkspaceError {
  if (err instanceof CloudWorkspaceError) return err
  return new CloudWorkspaceError("无法读取或更新本地工作区码云仓库的同步租约", "filesystem_error", err)
}
