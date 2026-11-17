import type { Message, SessionStatusInfo } from "../types/messages"

export interface MessageTurn {
  id: string
  user: Message
  assistant: Message[]
}

export function messageTurns(messages: Message[], boundary?: string) {
  const result: MessageTurn[] = []
  const by = new Map<string, MessageTurn>()

  for (const msg of messages) {
    if (msg.role === "user") {
      if (boundary && msg.id >= boundary) break
      const turn = { id: msg.id, user: msg, assistant: [] }
      result.push(turn)
      by.set(msg.id, turn)
      continue
    }

    if (msg.role !== "assistant") continue
    const turn = (msg.parentID ? by.get(msg.parentID) : undefined) ?? result[result.length - 1]
    if (turn) turn.assistant.push(msg)
  }

  return result
}

/**
 * Reuse previous turn objects when a turn's member messages are unchanged
 * (compared by store proxy identity). Part streaming lives in the parts
 * store, so during streaming every completed turn keeps its reference and
 * the virtualizer never remounts it. Borrowed from upstream Kilo's
 * stableMessageTurns idea, simplified to turn-level rows.
 */
export function stableTurns(prev: MessageTurn[] | undefined, next: MessageTurn[]): MessageTurn[] {
  if (!prev) return next
  const prior = new Map(prev.map((turn) => [turn.id, turn]))
  const same = next.map((turn) => {
    const old = prior.get(turn.id)
    if (!old || old.user !== turn.user || old.assistant.length !== turn.assistant.length) return turn
    for (let i = 0; i < turn.assistant.length; i++) if (old.assistant[i] !== turn.assistant[i]) return turn
    return old
  })
  if (same.length === prev.length && same.every((turn, i) => turn === prev[i])) return prev
  return same
}

function active(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== "assistant") continue
    if (typeof msg.time?.completed === "number") continue
    if (msg.error) continue
    if (msg.finish && !["tool-calls", "unknown"].includes(msg.finish)) continue
    if (!msg.parentID) break
    const parent = messages.find((item) => item.id === msg.parentID)
    if (parent?.role === "user") return parent.id
    break
  }

  return undefined
}

function done(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== "assistant") continue
    if (typeof msg.time?.completed === "number") return msg.parentID
    if (msg.error) return msg.parentID
    if (msg.finish && !["tool-calls", "unknown"].includes(msg.finish)) return msg.parentID
  }
  return undefined
}

function pending(messages: Message[]) {
  const users = messages.filter((msg) => msg.role === "user")
  const id = done(messages)
  if (!id) return users[0]?.id

  const idx = users.findIndex((msg) => msg.id === id)
  return users[idx + 1]?.id
}

// Find the user message whose turn the server is actively processing.
// Any user message after this one is "queued" (waiting for its turn).
export function activeUserMessageID(messages: Message[], status: SessionStatusInfo) {
  const id = active(messages)
  if (id) return id
  if (status.type === "idle") return undefined
  return pending(messages)
}

export function queuedUserMessageIDs(messages: Message[], status: SessionStatusInfo) {
  if (status.type === "idle") return []
  const users = messages.filter((msg) => msg.role === "user")
  const id = active(messages) ?? pending(messages)
  const idx = id ? users.findIndex((msg) => msg.id === id) : -1
  if (idx < 0) return []
  return users.slice(idx + 1).map((msg) => msg.id)
}
