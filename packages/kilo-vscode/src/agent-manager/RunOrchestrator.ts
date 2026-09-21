import * as path from "node:path"
import * as fsp from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { RepositoryProbeResult } from "./GitRepositoryProbe"
import type { RunRecord as StoredRunRecord, RunUpdate as StoredRunUpdate, RunEventInput as StoredRunEventInput } from "./RunStore"

/** Version of the public Agent Manager command protocol implemented here. */
export const AGENT_MANAGER_API_VERSION = 1 as const

/** The first protocol version supports at most four variants per run. */
export const MAX_RUN_VARIANTS = 4

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

export type RunEventType =
  | "run.created"
  | "run.status"
  | "repo.probe"
  | "repo.init.started"
  | "repo.init.completed"
  | "worktree.creating"
  | "worktree.ready"
  | "skill.staging"
  | "skill.ready"
  | "session.created"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "run.completed"
  | "run.partial"
  | "run.failed"
  | "run.cancelled"

export type RunErrorCode =
  | "api_version_unsupported"
  | "agent_manager_disabled"
  | "no_workspace"
  | "workspace_untrusted"
  | "not_git_repo"
  | "no_initial_commit"
  | "dirty_repo"
  | "git_init_cancelled"
  | "git_init_failed"
  | "git_identity_missing"
  | "git_lfs_missing"
  | "skill_not_found"
  | "skill_artifact_invalid"
  | "skill_sha_mismatch"
  | "path_outside_workspace"
  | "busy"
  | "session_create_failed"
  | "prompt_failed"
  | "cancelled"
  | "worktree_create_failed"
  | "invalid_request"
  | (string & {})

export interface RunError {
  code: RunErrorCode
  message: string
  retryable: boolean
  detail?: unknown
}

export interface SkillRef {
  kind: "skill" | "skillPkg"
  id: string
  name: string
  version?: string
  versionId?: string
  digest: string
  artifactPath: string
}

export interface RunVariantRequest {
  id: string
  skill?: SkillRef
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
  variant?: string
}

export interface RunWorktreeRequest {
  enabled: boolean
  baseBranch?: string
  gitPolicy: "require" | "init-if-needed"
  localOnly: boolean
  keep: boolean
}

export interface RunFile {
  mime: string
  url: string
  filename?: string
}

export interface AgentManagerRunRequest {
  apiVersion: 1
  requestId: string
  workspace?: string
  prompt: string
  variants: RunVariantRequest[]
  worktree: RunWorktreeRequest
  files?: RunFile[]
  reveal?: boolean
}

export interface RunWorktree {
  id: string
  path: string
  branch?: string
  parentBranch?: string
  remote?: string
}

export interface RunSession {
  id: string
  directory?: string
}

export interface RunMetrics {
  [key: string]: unknown
  /** Number of input/output tokens when the backend reports them. */
  tokens?: number
  /** Number of tool calls observed for the variant/run. */
  toolCalls?: number
  /** Number of changed files, when a diff provider supplies it. */
  files?: number
  additions?: number
  deletions?: number
  elapsedMs?: number
}

export interface RunVariantStatus {
  id: string
  status: VariantState
  worktreeId?: string
  worktree?: RunWorktree
  sessionId?: string
  session?: RunSession
  error?: RunError
  metrics?: RunMetrics
  startedAt?: string
  finishedAt?: string
}

export interface AgentManagerRunStatus {
  apiVersion: 1
  runId: string
  requestId: string
  status: RunState
  workspace?: string
  variants: RunVariantStatus[]
  metrics: RunMetrics
  createdAt: string
  updatedAt: string
  error?: RunError
}

/** Alias used by consumers that refer to the status simply as `RunStatus`. */
export type RunStatus = AgentManagerRunStatus

export interface AgentManagerRunResponse {
  accepted: boolean
  runId?: string
  status?: RunState
  variants?: Array<{ id: string; status: VariantState }>
  error?: RunError
}

export interface RunEvent {
  [key: string]: unknown
  apiVersion: 1
  runId: string
  variantId?: string
  seq: number
  at: string
  type: RunEventType | (string & {})
  sessionId?: string
  worktreeId?: string
  path?: string
  progress?: number
  error?: RunError
  status?: RunState | VariantState
  metrics?: RunMetrics
  detail?: unknown
}

export interface RunCapabilities {
  apiVersion: 1
  enabled: boolean
  features: Array<"run" | "events" | "cancel" | "repoInit" | "skillIsolation">
  maxVariants: number
}

export interface WorktreeCreateInput {
  runId: string
  variantId: string
  workspace: string
  prompt: string
  baseBranch?: string
  localOnly?: boolean
}

export interface WorktreeCreateResult {
  id?: string
  worktreeId?: string
  path: string
  branch?: string
  parentBranch?: string
  remote?: string
}

export interface SkillMaterializeInput {
  runId: string
  variantId: string
  workspace: string
  worktree: string
  skill: SkillRef
}

export interface SkillMaterializeResult {
  root?: string
  manifest?: Record<string, unknown>
}

export interface SkillValidateInput {
  runId: string
  variantId: string
  directory: string
  skillRoot?: string
  skill: SkillRef
}

export interface SessionCreateInput {
  runId: string
  variantId: string
  directory: string
  worktreeId?: string
  skillRoot?: string
}

export interface SessionCreateResult {
  id: string
  [key: string]: unknown
}

export interface PromptInput {
  runId: string
  variantId: string
  sessionId: string
  directory: string
  prompt: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  files?: RunFile[]
  skillRoot?: string
}

export interface SessionEvent {
  type: string
  properties?: Record<string, unknown>
  sessionID?: string
  sessionId?: string
  error?: unknown
}

export interface RunOrchestratorOptions {
  /** Current VS Code workspace. A function allows workspace changes at runtime. */
  root?: string | (() => string | undefined)
  workspace?: string | (() => string | undefined)
  /** Return false while Workspace Trust or an experiment gate is disabled. */
  trusted?: boolean | (() => boolean)
  enabled?: boolean | (() => boolean)
  maxVariants?: number
  maxEvents?: number
  now?: () => Date
  id?: () => string
  log?: (message: string) => void

  /** Preferred narrow adapters. */
  createWorktree?: (input: WorktreeCreateInput) => Promise<WorktreeCreateResult>
  createSession?: (input: SessionCreateInput) => Promise<SessionCreateResult>
  promptAsync?: (input: PromptInput) => Promise<unknown>
  abortSession?: (input: { sessionId: string; directory: string; runId: string; variantId: string }) => Promise<unknown>
  removeWorktree?: (input: { worktree: RunWorktree; keep: boolean; runId: string; variantId: string }) => Promise<unknown>
  materializeSkill?: (input: SkillMaterializeInput) => Promise<SkillMaterializeResult | undefined>
  validateSkill?: (input: SkillValidateInput) => Promise<unknown>
  /** Probe and, when requested, initialize the repository before worktrees. */
  probeRepository?: (root: string) => Promise<RepositoryProbeResult>
  bootstrapRepository?: (input: { root: string; runId: string; request: AgentManagerRunRequest }) => Promise<RepositoryProbeResult>

  /** Existing Agent Manager objects can be supplied instead of each adapter. */
  worktreeManager?: {
    createWorktree: (input: Record<string, unknown>) => Promise<WorktreeCreateResult>
    removeWorktree?: (path: string, branch?: string) => Promise<unknown>
  }
  client?: {
    session: {
      create: (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>
      promptAsync: (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>
      abort?: (input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>
    }
  }

  /** Subscribe to backend SSE events. */
  onEvent?: (listener: (event: SessionEvent) => void) => (() => void)
  emit?: (event: RunEvent) => void
  store?: RunStoreLike
}

/**
 * Minimal persistence contract. Methods are intentionally optional so the
 * orchestrator remains usable in tests and in hosts that only need memory.
 * A concrete RunStore can implement these methods without importing this file.
 */
export interface RunStoreLike {
  load?: () => unknown
  list?: () => unknown
  put?: (record: StoredRunRecord) => unknown
  create?: (record: StoredRunRecord) => unknown
  get?: (runId: string) => unknown
  findByRequestId?: (requestId: string) => unknown
  update?: (runId: string, patch: StoredRunUpdate) => unknown
  append?: (runId: string, event: StoredRunEventInput) => unknown
  listEvents?: (runId: string, afterSeq?: number) => unknown
  getEvents?: (runId: string, afterSeq?: number) => unknown
  cancel?: (runId: string) => unknown
}

interface InternalVariant extends RunVariantStatus {
  directory?: string
  skillRoot?: string
}

interface InternalRun extends AgentManagerRunStatus {
  variants: InternalVariant[]
  nextSeq: number
  request?: AgentManagerRunRequest
  events: RunEvent[]
  cancelled: boolean
}

type Listener = (event: RunEvent) => void

function text(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (!error || typeof error !== "object") return String(error)
  const value = error as Record<string, unknown>
  if (typeof value.message === "string") return value.message
  if (typeof value.error === "string") return value.error
  return "Unknown error"
}

function errorOf(error: unknown, fallback: RunErrorCode, retryable = false): RunError {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>
    const code = typeof value.code === "string" ? value.code : undefined
    const message = typeof value.message === "string" ? value.message : undefined
    if (code && message) {
      return {
        code,
        message,
        retryable: typeof value.retryable === "boolean" ? value.retryable : retryable,
        detail: value.detail,
      }
    }
  }
  return { code: fallback, message: text(error), retryable }
}

function value<T>(input: T | (() => T)): T {
  return typeof input === "function" ? (input as () => T)() : input
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase()
  return a === b
}

async function realPath(input: string): Promise<string> {
  const absolute = path.resolve(input)
  return fsp.realpath(absolute).catch(() => absolute)
}

function inside(root: string, child: string): boolean {
  const parent = path.normalize(path.resolve(root))
  const target = path.normalize(path.resolve(child))
  if (samePath(parent, target)) return true
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`
  if (process.platform === "win32") return target.toLowerCase().startsWith(prefix.toLowerCase())
  return target.startsWith(prefix)
}

function eventSession(event: SessionEvent): string | undefined {
  if (event.sessionID) return event.sessionID
  if (event.sessionId) return event.sessionId
  const props = event.properties
  if (!props) return undefined
  const sid = props.sessionID ?? props.sessionId
  return typeof sid === "string" ? sid : undefined
}

function eventError(event: SessionEvent): unknown {
  if (event.error !== undefined) return event.error
  return event.properties?.error
}

/**
 * Coordinates worktree/session creation and prompt execution for the public
 * Agent Manager command API. It deliberately has no VS Code dependency; the
 * extension supplies adapters through `RunOrchestratorOptions`.
 */
export class RunOrchestrator {
  private readonly opts: RunOrchestratorOptions
  private readonly runs = new Map<string, InternalRun>()
  private readonly listeners = new Set<Listener>()
  private readonly sessions = new Map<string, { runId: string; variantId: string }>()
  private readonly now: () => Date
  private readonly makeId: () => string
  private readonly max: number
  private readonly eventsMax: number
  private readonly log: (message: string) => void
  private unsubscribe: (() => void) | undefined
  private readonly ready: Promise<void>
  private readonly pending = new Map<string, Promise<AgentManagerRunResponse>>

  constructor(options: RunOrchestratorOptions = {}) {
    this.opts = options
    this.now = options.now ?? (() => new Date())
    this.makeId = options.id ?? (() => randomUUID())
    this.max = Math.max(1, Math.min(options.maxVariants ?? MAX_RUN_VARIANTS, MAX_RUN_VARIANTS))
    this.eventsMax = Math.max(1, Math.floor(options.maxEvents ?? 500))
    this.log = options.log ?? (() => undefined)
    if (options.onEvent) this.unsubscribe = options.onEvent((event) => this.handleSessionEvent(event))
    this.ready = this.loadStore()
  }

  capabilities(): RunCapabilities {
    const enabled = this.isEnabled()
    return {
      apiVersion: AGENT_MANAGER_API_VERSION,
      enabled,
      features: enabled ? ["run", "events", "cancel", "repoInit", "skillIsolation"] : [],
      maxVariants: this.max,
    }
  }

  /** Submit a run and return as soon as it has been queued. */
  async run(request: AgentManagerRunRequest): Promise<AgentManagerRunResponse> {
    const key = request?.requestId
    if (typeof key !== "string" || !key.trim()) return this.runInternal(request)
    const active = this.pending.get(key)
    if (active) return active
    const task = this.runInternal(request)
    this.pending.set(key, task)
    try {
      return await task
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key)
    }
  }

  private async runInternal(request: AgentManagerRunRequest): Promise<AgentManagerRunResponse> {
    await this.ready
    const checked = this.validate(request)
    if (checked) return { accepted: false, error: checked }

    const existing = await this.findByRequestId(request.requestId)
    if (existing) return this.response(existing)

    const resolved = await this.resolveRoot(request.workspace)
    if (!resolved.root) return { accepted: false, error: resolved.error ?? this.failure("no_workspace", "No workspace folder is open") }
    const root = resolved.root
    if (!this.isTrusted()) return { accepted: false, error: this.failure("workspace_untrusted", "Workspace is not trusted") }
    if (!this.isEnabled()) return { accepted: false, error: this.failure("agent_manager_disabled", "Agent Manager is disabled") }

    const stamp = this.now().toISOString()
    const runId = `run-${this.makeId()}`
    const run: InternalRun = {
      apiVersion: AGENT_MANAGER_API_VERSION,
      runId,
      requestId: request.requestId,
      status: "accepted",
      workspace: root,
      variants: request.variants.map((item) => ({ id: item.id, status: "queued" })),
      metrics: {},
      createdAt: stamp,
      updatedAt: stamp,
      nextSeq: 1,
      request,
      events: [],
      cancelled: false,
    }
    this.runs.set(runId, run)
    await this.persistRun(run)
    this.push(run, { type: "run.created", status: "accepted" })
    const response = this.response(run)
    setTimeout(() => void this.execute(run, root), 0)
    return response
  }

  /** Alias useful to command handlers that prefer an explicit name. */
  start(request: AgentManagerRunRequest): Promise<AgentManagerRunResponse> {
    return this.run(request)
  }

  async getRunStatus(runId: string): Promise<AgentManagerRunStatus | undefined> {
    await this.ready
    const local = this.runs.get(runId)
    if (local) return this.publicStatus(local)
    const store = this.opts.store
    const get = store?.get
    const stored = await Promise.resolve(get ? get.call(store, runId) : undefined)
    return this.asStatus(await Promise.resolve(stored))
  }

  getStatus(runId: string): Promise<AgentManagerRunStatus | undefined> {
    return this.getRunStatus(runId)
  }

  async getRunEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    await this.ready
    const local = this.runs.get(runId)
    if (local) return local.events.filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq)
    const store = this.opts.store
    const list = store?.listEvents
    const events = store?.getEvents
    const stored = list
      ? await Promise.resolve(list.call(store, runId, afterSeq))
      : events
        ? await Promise.resolve(events.call(store, runId, afterSeq))
        : undefined
    return this.asEvents(stored)
  }

  getEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    return this.getRunEvents(runId, afterSeq)
  }

  /** Cancel is idempotent for terminal and unknown runs. */
  async cancel(runId: string): Promise<{ accepted: boolean; status?: RunState; error?: RunError }> {
    await this.ready
    const run = this.runs.get(runId)
    if (!run) {
      const store = this.opts.store
      const get = store?.get
      const stored = this.asStatus(await Promise.resolve(get ? get.call(store, runId) : undefined))
      if (!stored) return { accepted: true }
      if (this.terminal(stored.status)) return { accepted: true, status: stored.status }
      const cancel = store?.cancel
      await Promise.resolve(cancel ? cancel.call(store, runId) : undefined)
      return { accepted: true, status: "cancelled" }
    }
    if (this.terminal(run.status)) return { accepted: true, status: run.status }
    run.cancelled = true
    run.status = "cancelled"
    run.error = this.failure("cancelled", "Run cancelled")
    this.touch(run)
    await Promise.all(
      run.variants.map(async (variant) => {
        if (this.terminalVariant(variant.status)) return
        if (variant.sessionId && variant.directory) {
          await this.abort(run, variant).catch(() => undefined)
        }
        variant.status = "cancelled"
        variant.error = this.failure("cancelled", "Variant cancelled")
        variant.finishedAt = this.now().toISOString()
      }),
    )
    await this.persistUpdate(run)
    this.push(run, { type: "run.cancelled", status: "cancelled" })
    await this.cleanup(run)
    return { accepted: true, status: run.status }
  }

  /** Accept backend session events and map them to variant/run state. */
  handleSessionEvent(event: SessionEvent): void {
    const sid = eventSession(event)
    if (!sid) return
    const found = this.sessions.get(sid)
    if (!found) return
    const run = this.runs.get(found.runId)
    const variant = run?.variants.find((item) => item.id === found.variantId)
    if (!run || !variant || this.terminalVariant(variant.status) || run.cancelled) return

    if (event.type === "session.error") {
      this.finishVariant(run, variant, "failed", errorOf(eventError(event), "prompt_failed"))
      return
    }
    if (event.type === "session.idle") {
      const reason = this.property(event, "reason")
      if (reason === "user_abort") {
        this.finishVariant(run, variant, "cancelled", this.failure("cancelled", "Variant cancelled"))
        return
      }
      if (reason === "error") {
        this.finishVariant(run, variant, "failed", errorOf(eventError(event), "prompt_failed"))
        return
      }
      this.finishVariant(run, variant, "succeeded")
      return
    }
    if (event.type === "session.status") {
      const status = this.property(event, "status")
      const kind = typeof status === "string" ? status : this.statusType(status)
      if (kind === "idle") {
        this.finishVariant(run, variant, "succeeded")
        return
      }
      if (kind === "error" || kind === "failed") {
        this.finishVariant(run, variant, "failed", errorOf(eventError(event), "prompt_failed"))
        return
      }
      if (kind === "busy" || kind === "running" || kind === "retry") {
        variant.status = "running"
        this.touch(run)
        this.push(run, { type: "task.progress", variantId: variant.id, progress: 0 })
      }
      return
    }
    if (event.type === "message.updated" || event.type === "message.part.updated") {
      if (variant.status === "prompt_sent") variant.status = "running"
      this.touch(run)
      this.push(run, { type: "task.progress", variantId: variant.id, progress: undefined })
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.listeners.clear()
    this.sessions.clear()
  }

  private async execute(run: InternalRun, root: string): Promise<void> {
    try {
      await this.executeFlow(run, root)
    } catch (cause) {
      if (!this.terminal(run.status)) this.failRun(run, this.asRunError(cause, "git_init_failed", true))
    }
  }

  private async executeFlow(run: InternalRun, root: string): Promise<void> {
    if (!run.request) return
    const request = run.request
    this.transition(run, "validating")
    if (run.cancelled) return

    if (request.worktree.enabled && request.worktree.gitPolicy === "init-if-needed") {
      // Git bootstrap is intentionally delegated to Agent Manager. The core
      // does not silently initialize a repository or trust caller confirmation.
      if (!this.opts.createWorktree && !this.opts.worktreeManager) {
        this.failRun(run, this.failure("not_git_repo", "A prepared Git repository is required in v1"))
        return
      }
    }

    if (request.worktree.enabled) {
      let probe: RepositoryProbeResult | undefined
      try {
        probe = this.opts.probeRepository ? await this.opts.probeRepository(root) : undefined
      } catch (cause) {
        this.failRun(run, errorOf(cause, "not_git_repo", true))
        return
      }
      if (probe) {
        this.push(run, { type: "repo.probe", path: probe.top ?? root, detail: probe })
        if (probe.kind === "dirty-repo") {
          this.failRun(run, this.failure("dirty_repo", "Working tree has uncommitted changes", false, probe.detail))
          return
        }
        if (probe.kind === "bare-repo" || probe.kind === "nested-repo" || probe.kind === "corrupt-repo") {
          this.failRun(run, probe.error ?? this.failure("not_git_repo", "Repository cannot host worktrees"))
          return
        }
        if (probe.kind === "no-repo" || probe.kind === "unborn-repo") {
          if (request.worktree.gitPolicy !== "init-if-needed") {
            this.failRun(run, this.failure(probe.kind === "unborn-repo" ? "no_initial_commit" : "not_git_repo", "A prepared Git repository is required"))
            return
          }
          if (!this.opts.bootstrapRepository) {
            this.failRun(run, this.failure("not_git_repo", "Git initialization is unavailable"))
            return
          }
          this.transition(run, "awaiting_confirmation")
          this.transition(run, "repo_initializing")
          this.push(run, { type: "repo.init.started" })
          try {
            const initialized = await this.opts.bootstrapRepository({ root, runId: run.runId, request })
            if (initialized && initialized.kind !== "ready" && initialized.kind !== "dirty-repo") {
              this.failRun(run, initialized.error ?? this.failure("git_init_failed", "Git initialization did not produce a ready repository", true))
              return
            }
            this.push(run, { type: "repo.init.completed", detail: initialized })
          } catch (cause) {
            this.failRun(run, this.asRunError(cause, "git_init_failed", true))
            return
          }
        }
      }
    }
    if (request.variants.some((item) => Boolean(item.skill))) this.transition(run, "staging")
    this.transition(run, request.worktree.enabled ? "creating_variants" : "starting_sessions")
    await Promise.all(request.variants.map((item) => this.executeVariant(run, item, root)))
    if (run.cancelled) return
    this.finishRun(run)
  }

  private async executeVariant(run: InternalRun, request: RunVariantRequest, root: string): Promise<void> {
    const variant = run.variants.find((item) => item.id === request.id)
    if (!variant || run.cancelled) return
    let stage: "worktree" | "skill" | "session" | "prompt" = "worktree"
    try {
      let directory = root
      if (run.request?.worktree.enabled) {
        stage = "worktree"
        variant.status = "worktree_creating"
        this.touch(run)
        this.push(run, { type: "worktree.creating", variantId: variant.id })
        const created = await this.createWorktree(run, request, root)
        if (run.cancelled) return
        const rootPath = await realPath(root)
        const worktreePath = await realPath(created.path)
        if (!inside(rootPath, worktreePath)) throw this.failure("path_outside_workspace", "Worktree path is outside workspace")
        const worktree: RunWorktree = {
          id: created.id ?? created.worktreeId ?? `wt-${this.makeId()}`,
          path: worktreePath,
          branch: created.branch,
          parentBranch: created.parentBranch,
          remote: created.remote,
        }
        variant.worktree = worktree
        variant.worktreeId = worktree.id
        directory = worktree.path
        variant.directory = directory
        this.touch(run)
        this.push(run, {
          type: "worktree.ready",
          variantId: variant.id,
          worktreeId: worktree.id,
          path: worktree.path,
        })
      }

      if (request.skill) {
        stage = "skill"
        variant.status = "skill_materializing"
        this.touch(run)
        this.push(run, { type: "skill.staging", variantId: variant.id, path: request.skill.artifactPath })
        const staged = await this.materialize(run, request, directory)
        if (staged?.root) {
          const skillRoot = await realPath(staged.root)
          if (!inside(await realPath(directory), skillRoot)) throw this.failure("path_outside_workspace", "Skill root is outside worktree")
          variant.skillRoot = skillRoot
        }
        this.touch(run)
        this.push(run, { type: "skill.ready", variantId: variant.id, path: variant.skillRoot })
      }

      stage = "session"
      variant.status = "session_creating"
      this.touch(run)
      const session = await this.createSession(run, request, directory, variant)
      if (run.cancelled) return
      variant.sessionId = session.id
      variant.session = { id: session.id, directory }
      variant.directory = directory
      this.sessions.set(session.id, { runId: run.runId, variantId: variant.id })
      this.touch(run)
      this.push(run, {
        type: "session.created",
        variantId: variant.id,
        sessionId: session.id,
        worktreeId: variant.worktreeId,
        path: directory,
      })

      if (request.skill && this.opts.validateSkill) {
        stage = "skill"
        await this.opts.validateSkill({
          runId: run.runId,
          variantId: variant.id,
          directory,
          skillRoot: variant.skillRoot,
          skill: request.skill,
        })
      }

      stage = "prompt"
      variant.status = "prompt_sent"
      this.touch(run)
      this.push(run, { type: "task.started", variantId: variant.id, sessionId: session.id })
      await this.prompt(run, request, directory, variant)
      if (run.cancelled) return
      // promptAsync returns immediately. Completion is driven by session SSE;
      // retain running state when no event has arrived yet.
      if (!this.terminalVariant(variant.status)) {
        variant.status = "running"
        this.touch(run)
        this.push(run, { type: "task.progress", variantId: variant.id, progress: 0 })
      }
    } catch (cause) {
      const fallback = stage === "worktree" ? "worktree_create_failed" : stage === "skill" ? "skill_artifact_invalid" : stage === "session" ? "session_create_failed" : "prompt_failed"
      const issue = this.asRunError(cause, fallback, true)
      if (stage === "skill" && variant.sessionId) {
        await this.abort(run, variant).catch((error) => this.log("Failed to abort invalid Skill session: " + text(error)))
      }
      this.finishVariant(run, variant, issue.code === "cancelled" ? "cancelled" : "failed", issue)
    }
  }

  private async createWorktree(run: InternalRun, request: RunVariantRequest, root: string): Promise<WorktreeCreateResult> {
    if (this.opts.createWorktree) {
      try {
        return await this.opts.createWorktree({
        runId: run.runId,
        variantId: request.id,
        workspace: root,
        prompt: run.request?.prompt ?? "",
        baseBranch: run.request?.worktree.baseBranch,
        localOnly: run.request?.worktree.localOnly,
        })
      } catch (cause) {
        throw errorOf(cause, "worktree_create_failed", true)
      }
    }
    const manager = this.opts.worktreeManager
    if (!manager) throw this.failure("not_git_repo", "Git worktree support is unavailable")
    try {
      return await manager.createWorktree({
        prompt: run.request?.prompt,
        baseBranch: run.request?.worktree.baseBranch,
        localOnly: run.request?.worktree.localOnly,
        runId: run.runId,
        variantId: request.id,
      })
    } catch (cause) {
      throw errorOf(cause, "worktree_create_failed", true)
    }
  }

  private async materialize(
    run: InternalRun,
    request: RunVariantRequest,
    directory: string,
  ): Promise<SkillMaterializeResult | undefined> {
    const skill = request.skill
    if (!skill) return undefined
    if (!skill.digest || !skill.artifactPath) throw this.failure("skill_artifact_invalid", "Skill artifact is incomplete")
    if (this.opts.materializeSkill) {
      return this.opts.materializeSkill({
        runId: run.runId,
        variantId: request.id,
        workspace: run.workspace ?? directory,
        worktree: directory,
        skill,
      })
    }
    return undefined
  }

  private async createSession(
    run: InternalRun,
    request: RunVariantRequest,
    directory: string,
    variant: InternalVariant,
  ): Promise<SessionCreateResult> {
    if (this.opts.createSession) {
      return this.opts.createSession({
        runId: run.runId,
        variantId: request.id,
        directory,
        worktreeId: variant.worktreeId,
        skillRoot: variant.skillRoot,
      })
    }
    const client = this.opts.client
    if (!client) throw this.failure("session_create_failed", "Session client is unavailable", true)
    const result = await client.session.create({ directory }, { throwOnError: true })
    const data = this.unwrap(result)
    if (!data || typeof data !== "object" || typeof (data as Record<string, unknown>).id !== "string") {
      throw this.failure("session_create_failed", "Session response did not include an id", true)
    }
    return data as SessionCreateResult
  }

  private async prompt(
    run: InternalRun,
    request: RunVariantRequest,
    directory: string,
    variant: InternalVariant,
  ): Promise<void> {
    const input: PromptInput = {
      runId: run.runId,
      variantId: request.id,
      sessionId: variant.sessionId!,
      directory,
      prompt: run.request?.prompt ?? "",
      model: request.model,
      agent: request.agent,
      variant: request.variant,
      files: run.request?.files,
      skillRoot: variant.skillRoot,
    }
    if (this.opts.promptAsync) {
      await this.opts.promptAsync(input)
      return
    }
    const client = this.opts.client
    if (!client) throw this.failure("prompt_failed", "Session client is unavailable", true)
    const parts = [
      ...(run.request?.files ?? []).map((file) => ({
        type: "file" as const,
        mime: file.mime,
        url: file.url,
        filename: file.filename,
      })),
      { type: "text" as const, text: run.request?.prompt ?? "" },
    ]
    await client.session.promptAsync(
      {
        sessionID: variant.sessionId,
        directory,
        parts,
        model: request.model,
        agent: request.agent,
        variant: request.variant,
      },
      { throwOnError: true },
    )
  }

  private async abort(run: InternalRun, variant: InternalVariant): Promise<void> {
    if (!variant.sessionId || !variant.directory) return
    if (this.opts.abortSession) {
      await this.opts.abortSession({
        sessionId: variant.sessionId,
        directory: variant.directory,
        runId: run.runId,
        variantId: variant.id,
      })
      return
    }
    const abort = this.opts.client?.session.abort
    if (abort) await abort({ sessionID: variant.sessionId, directory: variant.directory }, { throwOnError: false })
  }

  private async cleanup(run: InternalRun): Promise<void> {
    if (!run.request || run.request.worktree.keep) return
    await Promise.all(
      run.variants
        .filter((variant) => variant.worktree)
        .map(async (variant) => {
          const worktree = variant.worktree!
          if (this.opts.removeWorktree) {
            await this.opts.removeWorktree({ worktree, keep: false, runId: run.runId, variantId: variant.id }).catch((error) => {
              this.log("Failed to remove worktree " + worktree.path + ": " + text(error))
            })
            return
          }
          const remove = this.opts.worktreeManager?.removeWorktree
          if (remove) await remove(worktree.path, worktree.branch).catch((error) => {
            this.log("Failed to remove worktree " + worktree.path + ": " + text(error))
          })
        }),
    )
  }

  private finishVariant(run: InternalRun, variant: InternalVariant, status: VariantState, issue?: RunError): void {
    if (this.terminalVariant(variant.status)) return
    variant.status = status
    if (issue) variant.error = issue
    variant.finishedAt = this.now().toISOString()
    this.touch(run)
    this.push(run, {
      type: status === "succeeded" ? "task.completed" : "task.failed",
      variantId: variant.id,
      sessionId: variant.sessionId,
      worktreeId: variant.worktreeId,
      error: issue,
      progress: status === "succeeded" ? 1 : undefined,
    })
    if (run.variants.every((item) => this.terminalVariant(item.status))) void this.finishRunAsync(run)
  }

  private async finishRunAsync(run: InternalRun): Promise<void> {
    if (run.cancelled || this.terminal(run.status)) return
    this.finishRun(run)
  }

  private finishRun(run: InternalRun): void {
    if (run.cancelled || this.terminal(run.status)) return
    const good = run.variants.filter((item) => item.status === "succeeded").length
    const bad = run.variants.filter((item) => item.status === "failed").length
    const cancelled = run.variants.filter((item) => item.status === "cancelled").length
    if (good === run.variants.length) run.status = "completed"
    else if (good > 0) run.status = "partial"
    else if (cancelled === run.variants.length) run.status = "cancelled"
    else if (bad > 0) run.status = "failed"
    else return
    this.touch(run)
    const type: RunEventType =
      run.status === "completed" ? "run.completed" : run.status === "partial" ? "run.partial" : run.status === "cancelled" ? "run.cancelled" : "run.failed"
    this.push(run, { type, status: run.status, progress: 1 })
    void this.cleanup(run)
  }

  private failRun(run: InternalRun, issue: RunError): void {
    if (this.terminal(run.status)) return
    run.status = issue.code === "cancelled" ? "cancelled" : "failed"
    run.error = issue
    run.variants.forEach((variant) => {
      if (this.terminalVariant(variant.status)) return
      variant.status = run.status === "cancelled" ? "cancelled" : "failed"
      variant.error = issue
      variant.finishedAt = this.now().toISOString()
    })
    this.touch(run)
    this.push(run, { type: run.status === "cancelled" ? "run.cancelled" : "run.failed", status: run.status, error: issue })
    void this.cleanup(run)
  }

  private transition(run: InternalRun, status: RunState): void {
    if (run.cancelled || this.terminal(run.status)) return
    run.status = status
    this.touch(run)
    this.push(run, { type: "run.status", status })
  }

  private push(run: InternalRun, input: Omit<RunEvent, "apiVersion" | "runId" | "seq" | "at">): void {
    const event: RunEvent = {
      apiVersion: AGENT_MANAGER_API_VERSION,
      runId: run.runId,
      seq: run.nextSeq++,
      at: this.now().toISOString(),
      ...input,
    } as RunEvent
    run.events.push(event)
    if (run.events.length > this.eventsMax) run.events.splice(0, run.events.length - this.eventsMax)
    void this.persistEvent(run.runId, event)
    this.opts.emit?.(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.log("Run event listener failed: " + text(error))
      }
    }
  }

  private touch(run: InternalRun): void {
    run.updatedAt = this.now().toISOString()
    void this.persistUpdate(run)
  }

  private response(run: AgentManagerRunStatus): AgentManagerRunResponse {
    return {
      accepted: true,
      runId: run.runId,
      status: run.status,
      variants: run.variants.map((item) => ({ id: item.id, status: item.status })),
    }
  }

  private publicStatus(run: InternalRun): AgentManagerRunStatus {
    return {
      apiVersion: run.apiVersion,
      runId: run.runId,
      requestId: run.requestId,
      status: run.status,
      workspace: run.workspace,
      variants: run.variants.map((item) => ({
        id: item.id,
        status: item.status,
        worktreeId: item.worktreeId,
        worktree: item.worktree,
        sessionId: item.sessionId,
        session: item.session,
        error: item.error,
        metrics: item.metrics,
        startedAt: item.startedAt,
        finishedAt: item.finishedAt,
      })),
      metrics: run.metrics,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      error: run.error,
    }
  }

  private validate(request: AgentManagerRunRequest): RunError | undefined {
    if (!request || request.apiVersion !== AGENT_MANAGER_API_VERSION) {
      return this.failure("api_version_unsupported", "Unsupported Agent Manager API version")
    }
    if (typeof request.requestId !== "string" || !request.requestId.trim()) {
      return this.failure("invalid_request", "requestId is required")
    }
    if (typeof request.prompt !== "string" || !request.prompt.trim()) {
      return this.failure("invalid_request", "prompt is required")
    }
    if (!Array.isArray(request.variants) || request.variants.length < 1) {
      return this.failure("invalid_request", "At least one variant is required")
    }
    if (request.variants.length > this.max) {
      return this.failure("invalid_request", `At most ${this.max} variants are supported`)
    }
    const ids = new Set<string>()
    for (const variant of request.variants) {
      if (!variant || typeof variant.id !== "string" || !variant.id.trim() || ids.has(variant.id)) {
        return this.failure("invalid_request", "Variant ids must be non-empty and unique")
      }
      ids.add(variant.id)
    }
    if (!request.worktree || typeof request.worktree.enabled !== "boolean") {
      return this.failure("invalid_request", "worktree settings are required")
    }
    return undefined
  }

  private async resolveRoot(requested?: string): Promise<{ root?: string; error?: RunError }> {
    const source = this.opts.root ?? this.opts.workspace
    const configured = source ? value(source) : undefined
    const configRoot = configured ? await realPath(configured) : undefined
    const requestRoot = requested ? await realPath(requested) : undefined
    if (configRoot && requestRoot && !samePath(configRoot, requestRoot)) {
      return { error: this.failure("path_outside_workspace", "Requested workspace is outside the open workspace") }
    }
    const root = configRoot ?? requestRoot
    if (!root) return {}
    return { root }
  }

  private isTrusted(): boolean {
    return this.opts.trusted === undefined ? true : Boolean(value(this.opts.trusted))
  }

  private isEnabled(): boolean {
    return this.opts.enabled === undefined ? true : Boolean(value(this.opts.enabled))
  }

  private terminal(status: RunState): boolean {
    return status === "completed" || status === "partial" || status === "failed" || status === "cancelled"
  }

  private terminalVariant(status: VariantState): boolean {
    return status === "succeeded" || status === "failed" || status === "cancelled"
  }

  private failure(code: RunErrorCode, message: string, retryable = false, detail?: unknown): RunError {
    return { code, message, retryable, detail }
  }

  private asRunError(cause: unknown, fallback: RunErrorCode = "prompt_failed", retryable = false): RunError {
    return errorOf(cause, fallback, retryable)
  }

  private property(event: SessionEvent, key: string): unknown {
    return event.properties?.[key]
  }

  private statusType(input: unknown): string | undefined {
    if (!input || typeof input !== "object") return undefined
    const type = (input as Record<string, unknown>).type
    return typeof type === "string" ? type : undefined
  }

  private unwrap(input: unknown): unknown {
    if (!input || typeof input !== "object") return input
    const value = input as Record<string, unknown>
    return value.data ?? input
  }

  private async findByRequestId(requestId: string): Promise<InternalRun | AgentManagerRunStatus | undefined> {
    const local = [...this.runs.values()].find((run) => run.requestId === requestId)
    if (local) return local
    const store = this.opts.store
    const find = store?.findByRequestId
    const stored = await Promise.resolve(find ? find.call(store, requestId) : undefined)
    return this.asStatus(await Promise.resolve(stored))
  }

  private async loadStore(): Promise<void> {
    const store = this.opts.store
    if (!store) return
    const load = store.load
    if (load) await Promise.resolve(load.call(store))
    const list = store.list
    const listed = await Promise.resolve(list ? list.call(store) : undefined)
    if (!Array.isArray(listed)) return
    for (const item of listed) {
      const status = this.asStatus(item)
      if (!status) continue
      const request = this.asRequest(item)
      const events = await this.eventsFromStore(status.runId)
      const next = (events.at(-1)?.seq ?? 0) + 1
      const run: InternalRun = {
        ...status,
        variants: status.variants.map((variant) => ({ ...variant })),
        nextSeq: Math.max(1, next),
        events: events.slice(-this.eventsMax),
        cancelled: status.status === "cancelled",
        request,
      }
      this.runs.set(run.runId, run)
      for (const variant of run.variants) {
        if (variant.sessionId) this.sessions.set(variant.sessionId, { runId: run.runId, variantId: variant.id })
      }
    }
  }

  private async eventsFromStore(runId: string): Promise<RunEvent[]> {
    const store = this.opts.store
    if (!store) return []
    const list = store.listEvents
    const events = store.getEvents
    const listed = list
      ? await Promise.resolve(list.call(store, runId, 0))
      : events
        ? await Promise.resolve(events.call(store, runId, 0))
        : undefined
    return this.asEvents(listed)
  }

  private async persistRun(run: InternalRun): Promise<void> {
    const store = this.opts.store
    if (!store) return
    const status = this.publicStatus(run)
    const record: StoredRunRecord = {
      ...status,
      variants: status.variants.map((variant) => ({ ...variant })),
      request: run.request as unknown as Record<string, unknown> | undefined,
    }
    const put = store.put
    const create = store.create
    const result = put
      ? put.call(store, record)
      : create
        ? create.call(store, record)
        : undefined
    await Promise.resolve(result).catch((error) => {
      this.log("Failed to persist run: " + text(error))
    })
  }

  private async persistEvent(runId: string, event: RunEvent): Promise<void> {
    const store = this.opts.store
    const append = store?.append
    if (!append) return
    await Promise.resolve(append.call(store, runId, event)).catch((error) => {
      this.log("Failed to persist run event: " + text(error))
    })
  }

  private async persistUpdate(run: InternalRun): Promise<void> {
    const store = this.opts.store
    const update = store?.update
    if (!update) return
    await Promise.resolve(update.call(store, run.runId, {
      status: run.status,
      variants: run.variants as unknown as StoredRunRecord["variants"],
      metrics: run.metrics,
      error: run.error,
      updatedAt: run.updatedAt,
    })).catch((error) => {
      this.log("Failed to persist run update: " + text(error))
    })
  }

  private asStatus(input: unknown): AgentManagerRunStatus | undefined {
    if (!input || typeof input !== "object") return undefined
    const value = input as Record<string, unknown>
    const candidate = (value.run && typeof value.run === "object" ? value.run : value) as Record<string, unknown>
    if (
      candidate.apiVersion !== AGENT_MANAGER_API_VERSION ||
      typeof candidate.runId !== "string" ||
      typeof candidate.requestId !== "string" ||
      typeof candidate.status !== "string" ||
      !Array.isArray(candidate.variants) ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.updatedAt !== "string"
    ) return undefined
    const variants = candidate.variants.filter((variant): variant is RunVariantStatus => {
      if (!variant || typeof variant !== "object") return false
      const item = variant as Record<string, unknown>
      return typeof item.id === "string" && typeof item.status === "string"
    }).map((variant) => ({ ...variant }))
    return {
      apiVersion: AGENT_MANAGER_API_VERSION,
      runId: candidate.runId,
      requestId: candidate.requestId,
      status: candidate.status as RunState,
      workspace: typeof candidate.workspace === "string" ? candidate.workspace : undefined,
      variants,
      metrics: candidate.metrics && typeof candidate.metrics === "object" ? candidate.metrics as RunMetrics : {},
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      error: candidate.error && typeof candidate.error === "object" ? candidate.error as RunError : undefined,
    }
  }

  private asRequest(input: unknown): AgentManagerRunRequest | undefined {
    if (!input || typeof input !== "object") return undefined
    const value = input as Record<string, unknown>
    const request = value.request
    if (!request || typeof request !== "object") return undefined
    const item = request as Record<string, unknown>
    if (item.apiVersion !== AGENT_MANAGER_API_VERSION || typeof item.requestId !== "string" || typeof item.prompt !== "string") return undefined
    if (!Array.isArray(item.variants) || !item.worktree || typeof item.worktree !== "object") return undefined
    return item as unknown as AgentManagerRunRequest
  }

  private asEvents(input: unknown): RunEvent[] {
    if (!Array.isArray(input)) return []
    return input
      .filter((event): event is RunEvent => Boolean(
        event &&
        typeof event === "object" &&
        typeof (event as Record<string, unknown>).runId === "string" &&
        typeof (event as Record<string, unknown>).seq === "number" &&
        Number.isInteger((event as Record<string, unknown>).seq) &&
        typeof (event as Record<string, unknown>).at === "string" &&
        typeof (event as Record<string, unknown>).type === "string",
      ))
      .sort((a, b) => a.seq - b.seq)
  }
}

export default RunOrchestrator
