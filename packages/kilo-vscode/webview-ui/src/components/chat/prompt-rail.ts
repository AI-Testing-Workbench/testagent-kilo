import type { MessageTurn } from "../../context/session-queue"
import type { Part } from "../../types/messages"

export interface PromptRailItem {
  key: string
  turn: string
  queued: boolean
  prompt: string
  answer: string
  promoted: boolean
}

export type PromptRailEntry =
  | { type: "prompt"; item: PromptRailItem; index: number }
  | { type: "overflow"; count: number; index: number }
  | { type: "history" }

const PROMPT_LIMIT = 160
const ANSWER_LIMIT = 220

export const ROW_HEIGHT = 76
export const RAIL_INSET = 24
export const TICK_STEP = 14
export const TICK_MIN = 7

const cache = new WeakMap<Part[], Map<number, { raw: string[]; value: string }>>()

export function capacity(height: number): number {
  return Math.floor((height - RAIL_INSET) / TICK_MIN)
}

export function historyAction(before: number, after: number, more: boolean): "stop" | "load" | "jump" {
  if (after <= before) return "stop"
  return more ? "load" : "jump"
}

export function previewText(raw: string): string {
  const segments = raw.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  const value = segments.map((segment, index) => (index % 2 === 1 ? "" : stripLinks(segment))).join(" ")
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*>+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}

function stripLinks(value: string) {
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
}

function text(parts: Part[], limit: number): string {
  const raw = parts.map((part) => {
    if (part.type !== "text") return ""
    if ((part as Part & { synthetic?: boolean }).synthetic) return ""
    return part.text.trim().length > 0 ? part.text : ""
  })
  const prior = cache.get(parts)?.get(limit)
  if (prior && prior.raw.length === raw.length && prior.raw.every((value, index) => value === raw[index])) {
    return prior.value
  }
  const value = truncate(previewText(raw.filter(Boolean).join("\n")), limit)
  const values = cache.get(parts) ?? new Map()
  values.set(limit, { raw, value })
  cache.set(parts, values)
  return value
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

export function promptItems(
  turns: MessageTurn[],
  parts: (messageID: string) => Part[],
  queued: ReadonlySet<string> = new Set(),
  previous: PromptRailItem[] = [],
): PromptRailItem[] {
  return turns.map((turn, index) => {
    const prompt = text(parts(turn.user.id), PROMPT_LIMIT)
    const answer = truncate(
      turn.assistant
        .map((message) => text(parts(message.id), ANSWER_LIMIT))
        .filter(Boolean)
        .join(" "),
      ANSWER_LIMIT,
    )
    const promoted = !prompt && Boolean(answer)
    const item = {
      key: turn.id,
      turn: turn.id,
      queued: queued.has(turn.id),
      prompt: promoted ? truncate(answer, PROMPT_LIMIT) : prompt,
      answer: promoted ? "" : answer,
      promoted,
    }
    const prior = previous[index]
    if (!prior) return item
    if (
      prior.key !== item.key ||
      prior.queued !== item.queued ||
      prior.prompt !== item.prompt ||
      prior.answer !== item.answer ||
      prior.promoted !== item.promoted
    ) {
      return item
    }
    return prior
  })
}

function buildEntries(items: PromptRailItem[], capacity: number, history: boolean): PromptRailEntry[] {
  if (capacity < 1) return []
  if (!history && items.length <= capacity) {
    return items.map((item, index) => ({ type: "prompt", item, index }))
  }
  if (capacity === 1) {
    if (history) return [{ type: "history" }]
    const index = items.length - 1
    const item = items[index]
    return item ? [{ type: "prompt", item, index }] : []
  }
  if (capacity === 2) {
    const item = items.at(-1)
    const latest = item ? [{ type: "prompt" as const, item, index: items.length - 1 }] : []
    if (history) return [{ type: "history" }, ...latest]
    const first = items[0]
    return first ? [{ type: "prompt", item: first, index: 0 }, ...latest] : latest
  }

  const count = Math.min(items.length, capacity - 2)
  const start = items.length - count
  const recent = items.slice(start).map((item, offset) => ({
    type: "prompt" as const,
    item,
    index: start + offset,
  }))
  const prefix: PromptRailEntry[] = history
    ? [{ type: "history" }]
    : items[0]
      ? [{ type: "prompt", item: items[0], index: 0 }]
      : []
  const hidden = start - (history ? 0 : 1)
  if (hidden < 1) return [...prefix, ...recent]
  return [...prefix, { type: "overflow", count: hidden, index: history ? 0 : 1 }, ...recent]
}

export function railEntries(
  items: PromptRailItem[],
  capacity: number,
  history = false,
  previous: PromptRailEntry[] = [],
): PromptRailEntry[] {
  return buildEntries(items, capacity, history).map((entry, index) => {
    const prior = previous[index]
    if (!prior || prior.type !== entry.type) return entry
    if (entry.type === "history") return prior
    if (entry.type === "prompt" && prior.type === "prompt") {
      return prior.item === entry.item && prior.index === entry.index ? prior : entry
    }
    if (entry.type === "overflow" && prior.type === "overflow") {
      return prior.count === entry.count && prior.index === entry.index ? prior : entry
    }
    return entry
  })
}
