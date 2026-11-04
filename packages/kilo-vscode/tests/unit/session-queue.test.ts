import { describe, expect, it } from "bun:test"
import {
  activeUserMessageID,
  messageTurns,
  queuedUserMessageIDs,
  reuseTurns,
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

describe("reuseTurns", () => {
  it("复用未变化的 turn 对象，避免虚拟列表重挂载", () => {
    const base = [user("m1"), assistant("m2", "m1"), user("m3"), assistant("m4", "m3")]
    const first = messageTurns(base)
    expect(first).toHaveLength(2)

    const next = reuseTurns(first, messageTurns([...base, user("m5"), assistant("m6", "m5")]))

    expect(next[0]).toBe(first[0])
    expect(next[1]).toBe(first[1])
    expect(next).toHaveLength(3)
  })

  it("内容未变时返回原数组", () => {
    const base = [user("m1"), assistant("m2", "m1")]
    const first = messageTurns(base)

    expect(reuseTurns(first, messageTurns(base))).toBe(first)
  })

  it("清空会话时必须返回空数组（新建任务）", () => {
    const first = messageTurns([user("m1"), assistant("m2", "m1")])

    expect(reuseTurns(first, messageTurns([]))).toEqual([])
  })

  it("列表变短时跟随新长度", () => {
    const base = [user("m1"), assistant("m2", "m1"), user("m3"), assistant("m4", "m3")]
    const first = messageTurns(base)

    expect(reuseTurns(first, messageTurns(base.slice(0, 2)))).toHaveLength(1)
  })
})
