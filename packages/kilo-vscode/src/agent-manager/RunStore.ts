import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { KILO_DIR } from "./constants"

/** States used by the public Agent Manager run API. */
export type RunState =
  | "accepted"
  | "validating"
  | "awaiting_confirmation"
  | "repo_initializing"
  | "staging"
  | "creating_variants"
  | "starting_sessions"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"

/** States used by an individual run variant. */
export type VariantState =
  | "queued"
  | "worktree_creating"
  | "skill_materializing"
  | "session_creating"
  | "prompt_sent"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "awaiting_input"

export interface RunError {
  code: string
  message: string
  retryable: boolean
  detail?: unknown
}

export interface RunMetrics {
  [key: string]: unknown
}

/** Persisted state for one variant. Extra fields are intentionally allowed. */
export interface RunVariant {
  id: string
  status: VariantState
  worktreeId?: string
  path?: string
  sessionId?: string
  skill?: Record<string, unknown>
  model?: Record<string, unknown>
  error?: RunError
  metrics?: RunMetrics
  [key: string]: unknown
}

export interface RunRecord {
  apiVersion: 1
  runId: string
  requestId: string
  status: RunState
  variants: RunVariant[]
  createdAt: string
  updatedAt: string
  workspace?: string
  prompt?: string
  worktree?: Record<string, unknown>
  files?: Array<Record<string, unknown>>
  reveal?: boolean
  /** Original request payload, retained so a host restart can recover context. */
  request?: Record<string, unknown>
  metrics?: RunMetrics
  error?: RunError
  detail?: unknown
  [key: string]: unknown
}

/** Event shape exposed by getRunEvents. */
export interface RunEventInput {
  type: string
  seq?: number
  at?: string
  [key: string]: unknown
}

export interface RunEvent {
  apiVersion: 1
  runId: string
  seq: number
  at: string
  type: string
  variantId?: string
  sessionId?: string
  worktreeId?: string
  path?: string
  progress?: number
  error?: RunError
  detail?: unknown
  [key: string]: unknown
}

export interface RunCreateInput {
  requestId: string
  prompt?: string
  workspace?: string
  variants?: Array<Partial<RunVariant> & { id: string }>
  [key: string]: unknown
}

export interface RunStoreOptions {
  /** Override the persistence file (primarily useful for tests). */
  file?: string
  /** Maximum number of events retained for each run. */
  maxEvents?: number
  /** Clock injection makes state and event tests deterministic. */
  now?: () => Date
  /** ID injection is useful to make integration tests repeatable. */
  id?: () => string
  log?: (message: string) => void
}

export interface RunCreateResult {
  run: RunRecord
  created: boolean
}

/** Fields that may be changed after a run has been accepted. */
export interface RunUpdate {
  status?: RunState
  variants?: RunVariant[]
  updatedAt?: string
  workspace?: string
  prompt?: string
  worktree?: Record<string, unknown>
  files?: Array<Record<string, unknown>>
  reveal?: boolean
  /** Original request payload, retained so a host restart can recover context. */
  request?: Record<string, unknown>
  metrics?: RunMetrics
  error?: RunError
  detail?: unknown
  [key: string]: unknown
}

interface DiskData {
  version: 1
  runs: Record<string, RunRecord>
  events: Record<string, RunEvent[]>
  next: Record<string, number>
}

const FILE = "agent-manager-runs.json"
const VERSION = 1 as const
const DEFAULT_MAX_EVENTS = 500

function clone<T>(value: T): T {
  return structuredClone(value)
}

function text(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function id(): string {
  return `run-${crypto.randomUUID()}`
}

function terminal(state: RunState): boolean {
  return state === "completed" || state === "partial" || state === "failed" || state === "cancelled"
}

function validRun(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<RunRecord>
  return (
    item.apiVersion === 1 &&
    typeof item.runId === "string" &&
    typeof item.requestId === "string" &&
    typeof item.status === "string" &&
    Array.isArray(item.variants) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  )
}

function validEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<RunEvent>
  return (
    item.apiVersion === 1 &&
    typeof item.runId === "string" &&
    typeof item.seq === "number" &&
    Number.isInteger(item.seq) &&
    typeof item.at === "string" &&
    typeof item.type === "string"
  )
}

/**
 * Durable state and event log for Agent Manager runs.
 *
 * Mutating methods update memory synchronously and queue an atomic JSON write.
 * Call load() once during provider startup and flush() before disposing.
 */
export class RunStore {
  static readonly fileName = FILE

  private readonly file: string
  private readonly max: number
  private readonly now: () => Date
  private readonly makeId: () => string
  private readonly log: (message: string) => void
  private readonly runs = new Map<string, RunRecord>()
  private readonly events = new Map<string, RunEvent[]>()
  private readonly next = new Map<string, number>()
  private saving: Promise<void> | undefined
  private pending = false
  private loaded = false

  constructor(root: string, opts: RunStoreOptions | ((message: string) => void) = {}) {
    const options = typeof opts === "function" ? { log: opts } : opts
    this.file = options.file ?? path.join(root, KILO_DIR, FILE)
    this.max = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS))
    this.now = options.now ?? (() => new Date())
    this.makeId = options.id ?? id
    this.log = options.log ?? (() => {})
  }

  /** The path used by this store. */
  getFile(): string {
    return this.file
  }

  /** Whether load() has completed. */
  isLoaded(): boolean {
    return this.loaded
  }

  /** Load persisted state. Missing directories/files are treated as empty state. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.promises.readFile(this.file, "utf8")
      const data = JSON.parse(raw) as Partial<DiskData>
      this.runs.clear()
      this.events.clear()
      this.next.clear()

      for (const [runId, value] of Object.entries(data.runs ?? {})) {
        if (!validRun(value) || value.runId !== runId) continue
        this.runs.set(runId, this.normalizeRun(value))
      }
      for (const [runId, values] of Object.entries(data.events ?? {})) {
        if (!this.runs.has(runId) || !Array.isArray(values)) continue
        const list = values.filter(validEvent).map((event) => clone(event)).sort((a, b) => a.seq - b.seq)
        this.events.set(runId, list.slice(-this.max))
      }
      for (const [runId, value] of Object.entries(data.next ?? {})) {
        if (typeof value === "number" && Number.isInteger(value) && value > 0) this.next.set(runId, value)
      }
      for (const runId of this.runs.keys()) {
        const last = this.events.get(runId)?.at(-1)?.seq ?? 0
        const value = this.next.get(runId) ?? last + 1
        this.next.set(runId, Math.max(1, value, last + 1))
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") this.log(`Failed to load run store: ${text(error)}`)
    }
  }

  /** Wait for all queued writes. */
  async flush(): Promise<void> {
    while (this.saving || this.pending) {
      if (this.saving) {
        await this.saving
        continue
      }
      await this.save()
    }
  }

  /** Explicitly persist current state. */
  async save(): Promise<void> {
    if (this.saving) {
      this.pending = true
      await this.saving
      return
    }

    do {
      this.pending = false
      const task = this.write()
      this.saving = task
      try {
        await task
      } finally {
        if (this.saving === task) this.saving = undefined
      }
    } while (this.pending)
  }

  /** Persist an already-created run without changing its runId. */
  put(input: RunRecord): RunRecord {
    const run = this.normalizeRun(input)
    this.runs.set(run.runId, run)
    if (!this.events.has(run.runId)) this.events.set(run.runId, [])
    const last = this.events.get(run.runId)?.at(-1)?.seq ?? 0
    this.next.set(run.runId, Math.max(this.next.get(run.runId) ?? 1, last + 1))
    void this.save()
    return clone(run)
  }

  /** Create a run, returning the existing run when requestId was already seen. */
  create(input: RunCreateInput): RunRecord {
    return this.createRun(input).run
  }

  /** Create a run and indicate whether a new record was inserted. */
  createRun(input: RunCreateInput): RunCreateResult {
    const existing = this.findByRequestId(input.requestId)
    if (existing) return { run: existing, created: false }

    const stamp = this.now().toISOString()
    const runId = this.makeId()
    const variants = (input.variants ?? []).map((variant) => ({
      ...variant,
      id: variant.id,
      status: variant.status ?? "queued",
    })) as RunVariant[]
    const run: RunRecord = {
      ...(input as Record<string, unknown>),
      apiVersion: 1,
      runId,
      requestId: input.requestId,
      status: "accepted",
      variants,
      createdAt: stamp,
      updatedAt: stamp,
    }
    delete run.id
    this.runs.set(runId, run)
    this.events.set(runId, [])
    this.next.set(runId, 1)
    this.addEvent(runId, { type: "run.created" })
    void this.save()
    return { run: clone(run), created: true }
  }

  get(runId: string): RunRecord | undefined {
    const run = this.runs.get(runId)
    return run ? clone(run) : undefined
  }

  getRunStatus(runId: string): RunRecord | undefined {
    return this.get(runId)
  }

  findByRequestId(requestId: string): RunRecord | undefined {
    for (const run of this.runs.values()) if (run.requestId === requestId) return clone(run)
    return undefined
  }

  list(): RunRecord[] {
    return [...this.runs.values()].map((run) => clone(run))
  }

  /** Update mutable run fields and persist the change. */
  update(runId: string, patch: RunUpdate): RunRecord | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    const blocked = new Set(["apiVersion", "runId", "requestId", "createdAt", "updatedAt"])
    for (const [key, value] of Object.entries(patch)) {
      if (!blocked.has(key)) (run as Record<string, unknown>)[key] = value
    }
    if (patch.variants) run.variants = patch.variants.map((variant) => ({ ...variant }))
    run.updatedAt = typeof patch.updatedAt === "string" && patch.updatedAt.length > 0 ? patch.updatedAt : this.now().toISOString()
    void this.save()
    return clone(run)
  }

  /** Append an event and assign its run-local sequence number. */
  append(runId: string, event: RunEventInput): RunEvent | undefined {
    if (!this.runs.has(runId)) return undefined
    const value = this.addEvent(runId, event)
    const run = this.runs.get(runId)!
    run.updatedAt = value.at
    void this.save()
    return clone(value)
  }

  getRunEvents(runId: string, afterSeq = 0): RunEvent[] {
    return this.listEvents(runId, afterSeq)
  }

  getEvents(runId: string, afterSeq = 0): RunEvent[] {
    return this.listEvents(runId, afterSeq)
  }

  /** Return retained events with sequence strictly greater than afterSeq. */
  listEvents(runId: string, afterSeq = 0): RunEvent[] {
    const values = this.events.get(runId)
    if (!values) return []
    return values.filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq).map((event) => clone(event))
  }

  /** Cancel a run. Repeated cancellation of a terminal run is a no-op. */
  cancel(runId: string, variantId?: string): RunRecord | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    if (variantId) {
      const variant = run.variants.find((item) => item.id === variantId)
      if (!variant || variant.status === "cancelled" || variant.status === "succeeded" || variant.status === "failed") {
        return clone(run)
      }
      variant.status = "cancelled"
      variant.error = { code: "cancelled", message: "Variant cancelled", retryable: false }
      run.updatedAt = this.now().toISOString()
      this.addEvent(runId, { type: "task.failed", variantId, error: variant.error })
      void this.save()
      return clone(run)
    }
    if (terminal(run.status)) return clone(run)
    run.status = "cancelled"
    run.error = { code: "cancelled", message: "Run cancelled", retryable: false }
    run.updatedAt = this.now().toISOString()
    for (const variant of run.variants) {
      if (terminalVariant(variant.status)) continue
      variant.status = "cancelled"
      variant.error = { code: "cancelled", message: "Variant cancelled", retryable: false }
    }
    this.addEvent(runId, { type: "run.cancelled" })
    void this.save()
    return clone(run)
  }

  /** Subscribe to changes. Returns a disposable callback. */
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readonly listeners = new Set<(event: RunEvent) => void>()

  private addEvent(runId: string, input: RunEventInput): RunEvent {
    const next = this.next.get(runId) ?? 1
    const supplied = typeof input.seq === "number" && Number.isInteger(input.seq) && input.seq === next ? input.seq : undefined
    const seq = supplied ?? next
    const at = typeof input.at === "string" && input.at.length > 0 ? input.at : this.now().toISOString()
    const event = {
      ...input,
      apiVersion: 1 as const,
      runId,
      seq,
      at,
    } as RunEvent
    const list = this.events.get(runId) ?? []
    list.push(event)
    if (list.length > this.max) list.splice(0, list.length - this.max)
    this.events.set(runId, list)
    this.next.set(runId, seq + 1)
    for (const listener of this.listeners) {
      try {
        listener(clone(event))
      } catch (error) {
        this.log(`Run event listener failed: ${text(error)}`)
      }
    }
    return event
  }

  private normalizeRun(run: RunRecord): RunRecord {
    return {
      ...clone(run),
      variants: run.variants.map((variant) => ({ ...variant, status: variant.status ?? "queued" })),
    }
  }

  private async write(): Promise<void> {
    const data: DiskData = {
      version: VERSION,
      runs: Object.fromEntries([...this.runs].map(([runId, run]) => [runId, clone(run)])),
      events: Object.fromEntries([...this.events].map(([runId, events]) => [runId, events.map((event) => clone(event))])),
      next: Object.fromEntries(this.next),
    }
    const dir = path.dirname(this.file)
    const temp = `${this.file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(temp, JSON.stringify(data, null, 2), "utf8")
      try {
        await fs.promises.rename(temp, this.file)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error
        await fs.promises.rm(this.file, { force: true })
        await fs.promises.rename(temp, this.file)
      }
    } catch (error) {
      this.log(`Failed to save run store: ${text(error)}`)
      try {
        await fs.promises.rm(temp, { force: true })
      } catch (cleanupError) {
        this.log(`Failed to remove temporary run store: ${text(cleanupError)}`)
      }
      throw error
    }
  }
}

function terminalVariant(state: VariantState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled"
}

export const RUN_STORE_FILE = FILE


