import { describe, expect, it } from "bun:test"
import {
  activeUserMessageID,
  messageTurns,
  queuedUserMessageIDs,
  stableTurns,
} from "../../webview-ui/src/context/session-queue"
import type { Message } from "../../webview-ui/src/types/messages"

const base = {
  sessionID: "session",
  createdAt: "2026-01-01T00:00:00.000Z",
  time: { created: 1 },
}

const user = (id: string): Message => ({ ...base, id, role: "user" })

const assistant = (id: string, parentID: string, opts: Partial<Message> = {}): Message => ({
  ...base,
  id,
  parentID,
  role: "assistant",
  ...opts,
})

describe("queuedUserMessageIDs", () => {
  it("keeps follow-ups queued before the first assistant exists", () => {
    const messages = [user("message_1"), user("message_2")]

    expect(queuedUserMessageIDs(messages, { type: "busy" })).toEqual(["message_2"])
  })

  it("keeps follow-ups queued after a pending assistant parent", () => {
    const messages = [
      user("message_1"),
      assistant("message_2", "message_1", { finish: "tool-calls" }),
      user("message_3"),
    ]

    expect(queuedUserMessageIDs(messages, { type: "busy" })).toEqual(["message_3"])
  })

  it("keeps only later follow-ups queued after a terminal assistant", () => {
    const messages = [
      user("message_1"),
      assistant("message_2", "message_1", { finish: "stop" }),
      user("message_3"),
      user("message_4"),
    ]

    expect(queuedUserMessageIDs(messages, { type: "busy" })).toEqual(["message_4"])
  })

  it("keeps all follow-ups queued when the active assistant arrives after them", () => {
    const messages = [
      user("message_1"),
      user("message_3"),
      user("message_4"),
      assistant("message_2", "message_1", { finish: "tool-calls" }),
    ]

    expect(queuedUserMessageIDs(messages, { type: "busy" })).toEqual(["message_3", "message_4"])
  })

  it("returns no queued messages while idle", () => {
    const messages = [user("message_1"), user("message_2")]

    expect(queuedUserMessageIDs(messages, { type: "idle" })).toEqual([])
  })
})

describe("messageTurns", () => {
  it("attaches assistant output to its parent turn when queued users are newer", () => {
    const messages = [
      user("message_1"),
      user("message_3"),
      user("message_4"),
      assistant("message_2", "message_1", { finish: "tool-calls" }),
    ]

    expect(
      messageTurns(messages).map((turn) => ({
        user: turn.user.id,
        assistant: turn.assistant.map((msg) => msg.id),
      })),
    ).toEqual([
      { user: "message_1", assistant: ["message_2"] },
      { user: "message_3", assistant: [] },
      { user: "message_4", assistant: [] },
    ])
  })
})

describe("activeUserMessageID", () => {
  it("uses the first pending user before the first assistant exists", () => {
    const messages = [user("message_1"), user("message_2")]

    expect(activeUserMessageID(messages, { type: "busy" })).toBe("message_1")
  })

  it("ignores terminal assistant updates without completed timestamps", () => {
    const messages = [user("message_1"), assistant("message_2", "message_1", { finish: "stop" }), user("message_3")]

    expect(activeUserMessageID(messages, { type: "busy" })).toBe("message_3")
  })

  it("keeps tool-call assistants active until their follow-up finishes", () => {
    const messages = [
      user("message_1"),
      assistant("message_2", "message_1", { finish: "tool-calls" }),
      user("message_3"),
    ]

    expect(activeUserMessageID(messages, { type: "busy" })).toBe("message_1")
  })

  it("keeps unknown assistants active until cleanup finishes", () => {
    const messages = [user("message_1"), assistant("message_2", "message_1", { finish: "unknown" }), user("message_3")]

    expect(activeUserMessageID(messages, { type: "busy" })).toBe("message_1")
  })

  it("ignores aborted assistants without completed timestamps", () => {
    const messages = [
      user("message_1"),
      assistant("message_2", "message_1", { error: { name: "MessageAbortedError" } }),
      user("message_3"),
    ]

    expect(activeUserMessageID(messages, { type: "busy" })).toBe("message_3")
  })
})

describe("stableTurns", () => {
  it("returns the previous array unchanged when every turn is identical", () => {
    const messages = [user("message_1"), assistant("message_2", "message_1")]
    const first = messageTurns(messages)
    const second = messageTurns(messages)

    expect(stableTurns(first, second)).toBe(first)
  })

  it("reuses untouched turns and replaces only the mutated turn", () => {
    const before = messageTurns([user("message_1"), assistant("message_2", "message_1"), user("message_3")])
    const freshUser = user("message_3")
    const mutated = [before[0]!, { ...before[1]!, user: freshUser }]

    const result = stableTurns(before, mutated)

    expect(result[0]).toBe(before[0])
    expect(result[1]).toBe(mutated[1])
  })

  it("treats a changed assistant message reference as a new turn", () => {
    const messages = [user("message_1"), assistant("message_2", "message_1")]
    const before = messageTurns(messages)
    const rebuilt = messageTurns([...messages, assistant("message_3", "message_1")])

    expect(stableTurns(before, rebuilt)[0]).toBe(rebuilt[0])
  })

  it("returns the next list when there is no previous", () => {
    const turns = messageTurns([user("message_1")])

    expect(stableTurns(undefined, turns)).toBe(turns)
  })
})
