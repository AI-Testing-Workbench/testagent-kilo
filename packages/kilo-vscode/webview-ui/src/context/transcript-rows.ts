import type { Message, Part } from "../types/messages"
import type { MessageTurn } from "./session-queue"

/**
 * testagent_change start - row-level transcript architecture ported from upstream
 * kilocode (transcript-rows.ts). Turns are split into small virtualized rows
 * (user / assistant part chunks / timing / error / diff) so scrolling remounts a
 * chunk instead of a whole multi-thousand-pixel turn, and the growing live turn
 * renders outside the virtualizer (partitionRows direct tail) to stop height
 * corrections from fighting the bottom-pinned auto-scroll.
 */

export interface TurnStats {
  duration: string | null
  totalTokens: number
}

interface Base {
  key: string
  turn: string
  queued: boolean
  live: boolean
  message: Message
}

export interface TranscriptUserRow extends Base {
  type: "user"
  parts: Part[]
  interrupted: boolean
  answered: boolean
}

export interface TranscriptAssistantRow extends Base {
  type: "assistant"
  parts: Part[]
  copy?: string
}

export interface TranscriptTimingRow extends Base {
  type: "timing"
  stats: TurnStats
}

export interface TranscriptDiffRow extends Base {
  type: "diff"
  diffs: unknown[]
}

export interface TranscriptErrorRow extends Base {
  type: "error"
  error: NonNullable<Message["error"]>
}

export type TranscriptRow =
  | TranscriptUserRow
  | TranscriptAssistantRow
  | TranscriptTimingRow
  | TranscriptDiffRow
  | TranscriptErrorRow

export interface TranscriptOptions {
  size?: number
  queued?: ReadonlySet<string>
  live?: ReadonlySet<string>
  closed?: ReadonlySet<string>
  idle?: boolean
}

export interface TranscriptPartition {
  virtual: TranscriptRow[]
  direct: TranscriptRow[]
  queued: TranscriptRow[]
}

export interface TranscriptHold {
  sid: string
  turn: string
}

export function retainTurn(
  prev: TranscriptHold | undefined,
  sid: string | undefined,
  turn: string | undefined,
  paused: boolean,
) {
  if (!sid) return undefined
  if (!turn || paused) return prev?.sid === sid ? prev : turn ? { sid, turn } : undefined
  if (prev?.sid === sid && prev.turn === turn) return prev
  return { sid, turn }
}

/**
 * Turn ids that are definitely finished: a later user message exists in the
 * raw message list (even beyond the revert boundary), matching the settled
 * gating the turn-duration row used before this refactor.
 */
export function closedTurns(messages: Message[]): Set<string> {
  const result = new Set<string>()
  let seen = false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== "user") continue
    if (seen) result.add(msg.id)
    seen = true
  }
  return result
}

function same(a: Part[], b: Part[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameStats(a: TurnStats, b: TurnStats) {
  return a.duration === b.duration && a.totalTokens === b.totalTokens
}

function sameDiffs(a: unknown[], b: unknown[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function equal(a: TranscriptRow, b: TranscriptRow) {
  if (a.type !== b.type) return false
  if (a.turn !== b.turn || a.queued !== b.queued || a.live !== b.live) return false
  if (a.message !== b.message) return false
  if (a.type === "user" && b.type === "user") {
    return same(a.parts, b.parts) && a.interrupted === b.interrupted && a.answered === b.answered
  }
  if (a.type === "assistant" && b.type === "assistant") {
    return same(a.parts, b.parts) && a.copy === b.copy
  }
  if (a.type === "timing" && b.type === "timing") return sameStats(a.stats, b.stats)
  if (a.type === "diff" && b.type === "diff") return sameDiffs(a.diffs, b.diffs)
  if (a.type === "error" && b.type === "error") return a.error === b.error
  return false
}

function fmtDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes > 0) return `${minutes}分${remaining}秒`
  return `${seconds}秒`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export { fmtTokens }

/**
 * Duration/tokens for a settled turn. time.completed is also set on
 * intermediate tool-call steps and some providers report "stop" mid-loop, so
 * a turn counts as settled only when a later user message exists (closed) or
 * the session went idle with a final-step message. Mirrors the pre-refactor
 * gating so the duration row never mounts mid-session.
 */
function tokens(msgs: Message[]): number {
  let total = 0
  for (const msg of msgs) {
    const t = msg.tokens
    if (!t) continue
    total += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  }
  return total
}

function timing(turn: MessageTurn, closed: boolean, idle: boolean): TurnStats | undefined {
  const last = turn.assistant.at(-1)
  const end = last?.time?.completed
  if (typeof end !== "number") return undefined
  const final = !!last?.error || !["tool-calls", "unknown"].includes(last?.finish ?? "")
  if (!closed && !(idle && final)) return undefined
  const start = turn.user.time?.created
  const duration = typeof start === "number" ? fmtDuration(Math.max(0, end - start)) : null
  return { duration, totalTokens: tokens(turn.assistant) }
}

/** Keep the last diff per file, in original order — matches the old turn renderer. */
function diffs(msg: Message): unknown[] {
  const summary = msg.summary
  if (!summary || typeof summary === "boolean") return []
  const raw = summary.diffs
  if (!raw?.length) return []
  const seen = new Set<string>()
  return raw
    .reduceRight<unknown[]>((result, diff) => {
      const file = (diff as { file?: string }).file
      if (file && seen.has(file)) return result
      if (file) seen.add(file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}

function copy(msgs: Message[], parts: (messageID: string) => Part[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const found = parts(msgs[i]!.id)
    for (let j = found.length - 1; j >= 0; j -= 1) {
      const part = found[j]
      if (part?.type !== "text") continue
      if ((part as Part & { synthetic?: boolean }).synthetic) continue
      if (!(part as Part & { text: string }).text?.trim()) continue
      return part.id
    }
  }
  return undefined
}

export function transcriptRows(
  turns: MessageTurn[],
  getParts: (messageID: string) => Part[],
  opts: TranscriptOptions = {},
  prev: TranscriptRow[] = [],
): TranscriptRow[] {
  const size = Math.max(1, Math.floor(opts.size ?? 8))
  const rows: TranscriptRow[] = []
  for (const turn of turns) {
    const meta = {
      turn: turn.id,
      queued: opts.queued?.has(turn.id) === true,
      live: opts.live?.has(turn.id) === true,
    }
    const copied = copy(turn.assistant, getParts)
    rows.push({
      ...meta,
      type: "user",
      key: `${turn.id}:user`,
      message: turn.user,
      parts: getParts(turn.user.id),
      interrupted: turn.assistant.some((msg) => msg.error?.name === "MessageAbortedError"),
      answered: turn.assistant.length > 0,
    })
    for (const msg of turn.assistant) {
      const visible = getParts(msg.id)
      if (visible.length === 0) {
        rows.push({
          ...meta,
          type: "assistant",
          key: `${turn.id}:assistant:${msg.id}:empty`,
          message: msg,
          parts: visible,
          copy: copied,
        })
      } else {
        for (let start = 0; start < visible.length; start += size) {
          const chunk = visible.slice(start, start + size)
          rows.push({
            ...meta,
            type: "assistant",
            key: `${turn.id}:assistant:${msg.id}:${chunk[0]!.id}`,
            message: msg,
            parts: chunk,
            copy: copied,
          })
        }
      }
      if (msg.error && msg.error.name !== "MessageAbortedError") {
        rows.push({ ...meta, type: "error", key: `${turn.id}:error:${msg.id}`, message: msg, error: msg.error })
      }
    }
    const stats = timing(turn, opts.closed?.has(turn.id) === true, opts.idle === true)
    if (stats) {
      rows.push({ ...meta, type: "timing", key: `${turn.id}:timing`, message: turn.user, stats })
    }
    const changes = diffs(turn.user)
    if (changes.length > 0) {
      rows.push({ ...meta, type: "diff", key: `${turn.id}:diff`, message: turn.user, diffs: changes })
    }
  }
  if (prev.length === 0) return rows
  const prior = new Map(prev.map((row) => [row.key, row]))
  return rows.map((row) => {
    const old = prior.get(row.key)
    return old && equal(old, row) ? old : row
  })
}

/**
 * Only the latest live turn renders directly. Handing each finished step to
 * the virtualizer mid-turn mounts rows at the itemSize estimate while their
 * real height is unknown until measured; the correction fights the bottom pin
 * and rows near the range edge blink in and out of the DOM. One handoff
 * happens when the next turn starts.
 */
export function partitionRows(rows: TranscriptRow[], direct: ReadonlySet<string> = new Set()): TranscriptPartition {
  const queued = rows.filter((row) => row.queued)
  const visible = rows.filter((row) => !row.queued)
  const turn = visible.at(-1)?.turn
  if (!turn || !direct.has(turn)) return { virtual: visible, direct: [], queued }
  if (!visible.some((row) => row.turn === turn && row.type === "assistant")) {
    return { virtual: visible, direct: [], queued }
  }
  const boundary = visible.findIndex((row) => row.turn === turn)
  return {
    virtual: visible.slice(0, boundary),
    direct: visible.slice(boundary),
    queued,
  }
}

// testagent_change end
