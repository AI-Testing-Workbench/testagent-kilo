import * as fsp from "node:fs/promises"
import * as path from "node:path"
import type { SkillEvaluationModel } from "./skill-evaluation"
import type { SkillEvaluationMetrics } from "./SkillEvaluationMetricsClient"

export interface PendingSkillEvaluation {
  skillId: string
  skillName: string
  versionId: string
  version: string
  digest: string
  sessionId: string
  worktreeId?: string
  startedAt: string
  model?: SkillEvaluationModel
}

export interface SkillEvaluationResult extends PendingSkillEvaluation {
  id: string
  completedAt: string
  source: "local" | "api" | "mock"
  metrics: Partial<SkillEvaluationMetrics>
  metricsError?: string
}

interface SkillEvaluationState {
  schemaVersion: 1
  pending: PendingSkillEvaluation[]
  results: SkillEvaluationResult[]
}

function empty(): SkillEvaluationState {
  return { schemaVersion: 1, pending: [], results: [] }
}

export class SkillEvaluationStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  start(item: PendingSkillEvaluation): Promise<void> {
    return this.serial(async () => {
      const state = await this.load()
      state.pending = [item, ...state.pending.filter((entry) => entry.sessionId !== item.sessionId)]
      await this.write(state)
    })
  }

  discard(sessionId: string): Promise<void> {
    return this.serial(async () => {
      const state = await this.load()
      const pending = state.pending.filter((entry) => entry.sessionId !== sessionId)
      if (pending.length === state.pending.length) return
      state.pending = pending
      await this.write(state)
    })
  }

  finish(sessionId: string, metrics?: SkillEvaluationMetrics, metricsError?: string): Promise<SkillEvaluationResult | undefined> {
    return this.serial(async () => {
      const state = await this.load()
      const item = state.pending.find((entry) => entry.sessionId === sessionId)
      if (!item) return undefined
      const result: SkillEvaluationResult = {
        ...item,
        id: sessionId,
        completedAt: new Date().toISOString(),
        source: "local",
        metrics: metrics ?? {},
        ...(metricsError ? { metricsError } : {}),
      }
      state.pending = state.pending.filter((entry) => entry.sessionId !== sessionId)
      state.results = [result, ...state.results.filter((entry) => entry.sessionId !== sessionId)].slice(0, 2_000)
      await this.write(state)
      return result
    })
  }

  list(skillId: string): Promise<SkillEvaluationResult[]> {
    return this.serial(async () => {
      const state = await this.load()
      return state.results
        .filter((entry) => entry.skillId === skillId)
        .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
    })
  }

  pending(skillId?: string): Promise<PendingSkillEvaluation[]> {
    return this.serial(async () => {
      const state = await this.load()
      return state.pending
        .filter((entry) => !skillId || entry.skillId === skillId)
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    })
  }

  refresh(
    skillId: string,
    sessionId: string,
    metrics?: SkillEvaluationMetrics,
    metricsError?: string,
  ): Promise<SkillEvaluationResult | undefined> {
    return this.serial(async () => {
      const state = await this.load()
      const item = state.results.find((entry) => entry.skillId === skillId && entry.sessionId === sessionId)
      if (!item) return undefined
      const result: SkillEvaluationResult = {
        ...item,
        completedAt: new Date().toISOString(),
        source: "local",
        metrics: metrics ? { ...item.metrics, ...metrics } : item.metrics,
        ...(metricsError ? { metricsError } : { metricsError: undefined }),
      }
      state.results = state.results.map((entry) => (entry.sessionId === sessionId ? result : entry))
      await this.write(state)
      return result
    })
  }

  remove(skillId: string, sessionId: string): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.load()
      const results = state.results.filter((entry) => !(entry.skillId === skillId && entry.sessionId === sessionId))
      if (results.length === state.results.length) return false
      state.results = results
      await this.write(state)
      return true
    })
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const current = this.queue.then(task)
    this.queue = current.then(
      () => undefined,
      (error) => this.log("Skill evaluation store operation failed: " + String(error)),
    )
    return current
  }

  private async load(): Promise<SkillEvaluationState> {
    const raw = await fsp.readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    if (!raw) return empty()
    const value = JSON.parse(raw) as Partial<SkillEvaluationState>
    if (value.schemaVersion !== 1 || !Array.isArray(value.pending) || !Array.isArray(value.results)) {
      throw new Error("Invalid Skill evaluation result store")
    }
    return { schemaVersion: 1, pending: value.pending, results: value.results }
  }

  private async write(state: SkillEvaluationState): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    await fsp.writeFile(this.file, JSON.stringify(state, null, 2), "utf8")
  }
}
