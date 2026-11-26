import { describe, expect, it } from "bun:test"
import {
  closedTurns,
  partitionRows,
  retainTurn,
  transcriptRows,
  type TranscriptRow,
} from "../../webview-ui/src/context/transcript-rows"
import type { MessageTurn } from "../../webview-ui/src/context/session-queue"
import type { Message, Part } from "../../webview-ui/src/types/messages"

const base = {
  sessionID: "session",
  createdAt: "2026-01-01T00:00:00.000Z",
  time: { created: 1000 },
}

const user = (id: string, opts: Partial<Message> = {}): Message => ({ ...base, id, role: "user", ...opts })

const assistant = (id: string, parentID: string, opts: Partial<Message> = {}): Message => ({
  ...base,
  id,
  parentID,
  role: "assistant",
  ...opts,
})

const text = (id: string, messageID: string, value = "x"): Part => ({
  id,
  sessionID: "session",
  messageID,
  type: "text",
  text: value,
})

const partsOf = (lists: Record<string, Part[]>) => (id: string) => lists[id] ?? []

const turn = (id: string, msgs: Message[]): MessageTurn => ({
  id,
  user: msgs[0]!,
  assistant: msgs.slice(1),
})

describe("transcriptRows", () => {
  it("splits assistant parts into stable chunk rows", () => {
    const msg = assistant("a1", "u1")
    const list = Array.from({ length: 10 }, (_, i) => text(`p${i}`, "a1"))
    const rows = transcriptRows([turn("u1", [user("u1"), msg])], partsOf({ a1: list }))
    const assistantRows = rows.filter((row) => row.type === "assistant")
    expect(assistantRows.length).toBe(2)
    expect(assistantRows[0]!.key).toBe("u1:assistant:a1:p0")
    expect(assistantRows[1]!.key).toBe("u1:assistant:a1:p8")
    expect(assistantRows.map((row) => row.parts.length)).toEqual([8, 2])
  })

  it("keeps a row for messages without parts", () => {
    const rows = transcriptRows([turn("u1", [user("u1"), assistant("a1", "u1")])], partsOf({}))
    expect(rows.some((row) => row.key === "u1:assistant:a1:empty")).toBe(true)
  })

  it("interleaves an error row after its message rows", () => {
    const failed = assistant("a2", "u1", { error: { name: "APIError", data: {} } })
    const rows = transcriptRows([turn("u1", [user("u1"), assistant("a1", "u1"), failed])], partsOf({}))
    const kinds = rows.map((row) => row.type)
    expect(kinds).toEqual(["user", "assistant", "assistant", "error"])
  })

  it("skips aborted errors (rendered as interrupted user rows)", () => {
    const aborted = assistant("a1", "u1", { error: { name: "MessageAbortedError" } })
    const rows = transcriptRows([turn("u1", [user("u1"), aborted])], partsOf({}))
    expect(rows.some((row) => row.type === "error")).toBe(false)
    const userRow = rows.find((row) => row.type === "user")!
    expect(userRow.type === "user" && userRow.interrupted).toBe(true)
  })

  it("dedupes diffs keeping the last entry per file", () => {
    const withDiffs = user("u1", {
      summary: {
        diffs: [
          { file: "a.ts", additions: 1 },
          { file: "b.ts", additions: 2 },
          { file: "a.ts", additions: 3 },
        ],
      },
    })
    const rows = transcriptRows([turn("u1", [withDiffs])], partsOf({}))
    const diffRow = rows.find((row) => row.type === "diff")
    expect(diffRow?.type === "diff" && diffRow.diffs).toEqual([
      { file: "b.ts", additions: 2 },
      { file: "a.ts", additions: 3 },
    ])
  })

  it("anchors the copy id to the last non-empty text part of the turn", () => {
    const a1 = assistant("a1", "u1")
    const a2 = assistant("a2", "u1")
    const lists = {
      a1: [text("p1", "a1", "first"), text("p2", "a1", "")],
      a2: [text("p3", "a2", "last")],
    }
    const rows = transcriptRows([turn("u1", [user("u1"), a1, a2])], partsOf(lists))
    const assistantRows = rows.filter((row) => row.type === "assistant")
    expect(assistantRows.every((row) => row.type === "assistant" && row.copy === "p3")).toBe(true)
  })
})

describe("timing rows", () => {
  const settled = assistant("a1", "u1", {
    finish: "stop",
    time: { created: 1000, completed: 91000 },
    tokens: { input: 100, output: 50 },
  })

  it("does not appear while the turn is active and not closed", () => {
    const rows = transcriptRows([turn("u1", [user("u1"), settled])], partsOf({}), { idle: false })
    expect(rows.some((row) => row.type === "timing")).toBe(false)
  })

  it("appears once the session goes idle on a final step", () => {
    const rows = transcriptRows([turn("u1", [user("u1"), settled])], partsOf({}), { idle: true })
    const timing = rows.find((row) => row.type === "timing")
    expect(timing?.type === "timing" && timing.stats).toEqual({ duration: "1分30秒", totalTokens: 150 })
  })

  it("appears for closed turns even while the session is busy", () => {
    const rows = transcriptRows([turn("u1", [user("u1"), settled])], partsOf({}), {
      idle: false,
      closed: new Set(["u1"]),
    })
    expect(rows.some((row) => row.type === "timing")).toBe(true)
  })

  it("stays hidden for intermediate tool-call steps even when idle", () => {
    const step = assistant("a1", "u1", { finish: "tool-calls", time: { created: 1000, completed: 5000 } })
    const rows = transcriptRows([turn("u1", [user("u1"), step])], partsOf({}), { idle: true })
    expect(rows.some((row) => row.type === "timing")).toBe(false)
  })

  it("treats provider-reported stop on intermediate steps as unsettled while busy", () => {
    const quirk = assistant("a1", "u1", { finish: "stop", time: { created: 1000, completed: 5000 } })
    const rows = transcriptRows([turn("u1", [user("u1"), quirk])], partsOf({}), { idle: false })
    expect(rows.some((row) => row.type === "timing")).toBe(false)
  })
})

describe("row reuse", () => {
  it("returns previous row objects when nothing changed", () => {
    const msgs = [user("u1"), assistant("a1", "u1")]
    const lists = { a1: [text("p1", "a1")] }
    const first = transcriptRows([turn("u1", msgs)], partsOf(lists))
    const second = transcriptRows([turn("u1", msgs)], partsOf(lists), {}, first)
    expect(second).toEqual(first)
    expect(second.every((row, i) => row === first[i])).toBe(true)
  })

  it("replaces only the rows whose parts changed", () => {
    const msgs = [user("u1"), assistant("a1", "u1")]
    const first = transcriptRows([turn("u1", msgs)], partsOf({ a1: [text("p1", "a1")] }))
    const lists = { a1: [text("p1", "a1"), text("p2", "a1")] }
    const second = transcriptRows([turn("u1", msgs)], partsOf(lists), {}, first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
  })
})

describe("partitionRows", () => {
  const build = (): TranscriptRow[] =>
    transcriptRows(
      [
        turn("u1", [user("u1"), assistant("a1", "u1")]),
        turn("u2", [user("u2"), assistant("a2", "u2")]),
        turn("u3", [user("u3")]),
      ],
      partsOf({ a1: [text("p1", "a1")], a2: [text("p2", "a2")] }),
      { queued: new Set(["u3"]) },
    )

  it("separates queued rows", () => {
    const partition = partitionRows(build())
    expect(partition.queued.map((row) => row.turn)).toEqual(["u3"])
    expect(partition.virtual.length).toBe(4)
  })

  it("moves the whole live turn to direct rendering", () => {
    const rows = build()
    const partition = partitionRows(rows, new Set(["u2"]))
    expect(partition.virtual.every((row) => row.turn === "u1")).toBe(true)
    expect(partition.direct.map((row) => row.turn)).toEqual(["u2", "u2"])
  })

  it("keeps everything virtual when the direct turn has no assistant rows", () => {
    const partition = partitionRows(build(), new Set(["u3"]))
    expect(partition.direct.length).toBe(0)
  })
})

describe("closedTurns", () => {
  it("marks every user message that has a later user message", () => {
    const ids = closedTurns([user("u1"), assistant("a1", "u1"), user("u2"), assistant("a2", "u2")])
    expect([...ids]).toEqual(["u1"])
  })
})

describe("retainTurn", () => {
  it("keeps holding the previous turn while the session id matches", () => {
    const prev = { sid: "s", turn: "u1" }
    expect(retainTurn(prev, "s", undefined, false)).toBe(prev)
    expect(retainTurn(prev, "s", "u2", false)).toEqual({ sid: "s", turn: "u2" })
    expect(retainTurn(prev, "other", "u2", false)).toEqual({ sid: "other", turn: "u2" })
  })
})
