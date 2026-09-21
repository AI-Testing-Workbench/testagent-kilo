import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { SkillEvaluationMetrics } from "./SkillEvaluationMetricsClient"

type Rec = Record<string, unknown>
type Msg = {
  id: string
  role: string
  time?: { created?: number; completed?: number; llm?: number }
  tokens?: {
    input: number
    output: number
    reasoning?: number
    total?: number
    cache?: { read?: number; write?: number }
  }
  parts: Part[]
}
type Part = {
  id?: string
  type?: string
  tool?: string
  metadata?: Rec
  state?: Rec
}
type Span = [number, number]

function rec(value: unknown): Rec | undefined {
  return value && typeof value === "object" ? (value as Rec) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function child(part: Part): string | undefined {
  if (part.type !== "tool" || part.tool !== "task") return undefined
  return str(rec(part.metadata)?.sessionId) ?? str(rec(part.state)?.metadata && rec(rec(part.state)?.metadata)?.sessionId)
}

function stateTime(part: Part): { start?: number; end?: number; status?: string } {
  const state = rec(part.state)
  const time = rec(state?.time)
  return { start: num(time?.start), end: num(time?.end), status: str(state?.status) }
}

function union(spans: Span[]): number {
  return spans
    .sort((a, b) => a[0] - b[0])
    .reduce(
      (sum, span) => ({
        total: sum.total + Math.max(0, span[1] - Math.max(span[0], sum.end)),
        end: Math.max(sum.end, span[1]),
      }),
      { total: 0, end: 0 },
    ).total
}

function timing(
  family: Set<string>,
  messages: Map<string, Msg[]>,
  waits: Readonly<Record<string, number>>,
): number | undefined {
  const llmSpans: Span[] = []
  const toolSpans: Span[] = []
  const intervals: Span[] = []
  const seenMessages = new Set<string>()
  const seenParts = new Set<string>()
  let has = false
  let wait = 0

  for (const sid of family) {
    const list = messages.get(sid) ?? []
    for (const message of list) {
      if (message.role !== "assistant" || seenMessages.has(message.id)) continue
      seenMessages.add(message.id)
      const created = message.time?.created
      const span = message.time?.llm ?? 0
      if (created && span > 0) {
        const end = message.time?.completed ? Math.min(message.time.completed, created + span) : created + span
        llmSpans.push([created, end])
      }
      if (created && message.time?.completed) intervals.push([created, message.time.completed])
      has = true
      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index]
        const key = part.id ?? `${message.id}:${index}`
        if (seenParts.has(key)) continue
        seenParts.add(key)
        const childID = child(part)
        if (part.tool === "task" && childID && family.has(childID)) continue
        if (part.type !== "tool") continue
        const value = stateTime(part)
        if (!value.start) continue
        const end = value.end ?? Date.now()
        const duration = Math.max(0, end - value.start)
        if (part.tool === "question" || part.tool === "invalid") {
          wait += duration
          continue
        }
        toolSpans.push([value.start, end])
      }
    }
    wait += waits[sid] ?? 0
  }

  if (!has) return undefined
  const llm = union(llmSpans)
  if (llm === 0) return undefined
  const tool = union(toolSpans)
  const elapsed = union(intervals)
  return elapsed || llm + tool + wait
}

function tokenTotals(family: Set<string>, messages: Map<string, Msg[]>): {
  input: number
  output: number
  total?: number
} {
  let input = 0
  let output = 0
  let total: number | undefined
  let hasTotal = false
  for (const sid of family) {
    for (const message of messages.get(sid) ?? []) {
      if (message.role !== "assistant" || !message.tokens) continue
      input += message.tokens.input
      output += message.tokens.output
      if (message.tokens.total != null) {
        total = (total ?? 0) + message.tokens.total
        hasTotal = true
      }
    }
  }
  if (!hasTotal) total = undefined
  return { input, output, total }
}

function normalize(value: unknown): Msg[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const object = rec(item)
    if (!object) return []
    const info = rec(object.info)
    if (!info) return []
    const id = str(info.id)
    const role = str(info.role)
    if (!id || !role) return []
    const time = rec(info.time)
    const token = rec(info.tokens)
    const tokens = token && num(token.input) !== undefined && num(token.output) !== undefined
      ? {
          input: num(token.input) ?? 0,
          output: num(token.output) ?? 0,
          reasoning: num(token.reasoning),
          total: num(token.total),
          cache: rec(token.cache)
            ? { read: num(rec(token.cache)?.read), write: num(rec(token.cache)?.write) }
            : undefined,
        }
      : undefined
    const parts = Array.isArray(object.parts) ? object.parts.flatMap((part) => {
      const item = rec(part)
      return item ? [{ ...item, metadata: rec(item.metadata), state: rec(item.state) }] : []
    }) : []
    return [{
      id,
      role,
      time: time ? { created: num(time.created), completed: num(time.completed), llm: num(time.llm) } : undefined,
      tokens,
      parts,
    }]
  })
}

export interface SessionEvaluationMetricsInput {
  client: KiloClient
  directory: string
  sessionId: string
  permissionWaits?: Readonly<Record<string, number>>
  hitlCounts?: Readonly<Record<string, number>>
}

export async function collectSessionEvaluationMetrics(input: SessionEvaluationMetricsInput): Promise<SkillEvaluationMetrics> {
  const family = new Set<string>()
  const queue = [input.sessionId]
  const messages = new Map<string, Msg[]>()
  const waits = input.permissionWaits ?? {}
  while (queue.length > 0) {
    const sid = queue.shift()
    if (!sid || family.has(sid)) continue
    family.add(sid)
    const response = await input.client.session.messages(
      { sessionID: sid, directory: input.directory },
      { throwOnError: true },
    )
    const list = normalize(response.data)
    messages.set(sid, list)
    for (const message of list) {
      for (const part of message.parts) {
        const next = child(part)
        if (next && !family.has(next)) queue.push(next)
      }
    }
  }

  const seenParts = new Set<string>()
  let toolCalls = 0
  let toolErrorCount = 0
  let subagentCount = 0
  let compactedCount = 0
  let userPromptCount = 0
  let questionCount = 0
  for (const list of messages.values()) {
    for (const message of list) {
      if (message.role === "user" && !message.parts.some((part) => part.type === "compaction")) userPromptCount += 1
      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index]
        const key = part.id ?? `${message.id}:${index}`
        if (seenParts.has(key)) continue
        seenParts.add(key)
        if (part.type === "compaction") compactedCount += 1
        if (part.type !== "tool") continue
        toolCalls += 1
        if (stateTime(part).status === "error") toolErrorCount += 1
        if (part.tool === "task") subagentCount += 1
        if (part.tool === "question") questionCount += 1
      }
    }
  }

  userPromptCount += questionCount
  const totals = tokenTotals(family, messages)
  const explicitHitl = input.hitlCounts
    ? [...family].reduce((sum, sid) => sum + (input.hitlCounts?.[sid] ?? 0), 0)
    : undefined
  const hitlCount = explicitHitl === undefined ? questionCount : explicitHitl
  const totalTokens = totals.total ?? totals.input + totals.output + [...family].reduce((sum, sid) => {
    for (const message of messages.get(sid) ?? []) {
      if (message.role !== "assistant" || !message.tokens) continue
      sum += message.tokens.cache?.read ?? 0
      sum += message.tokens.cache?.write ?? 0
    }
    return sum
  }, 0)
  return {
    toolCalls,
    toolErrorCount,
    subagentCount,
    compactedCount,
    userPromptCount,
    inputTokens: totals.input,
    outputTokens: totals.output,
    totalTokens,
    hitlCount,
    elapsedMs: timing(family, messages, waits) ?? 0,
  }
}