import { describe, expect, it } from "bun:test"
import { messageTurns } from "../../webview-ui/src/context/session-queue"
import type { Message, Part, TextPart } from "../../webview-ui/src/types/messages"
import {
  capacity,
  historyAction,
  previewText,
  promptItems,
  railEntries,
} from "../../webview-ui/src/components/chat/prompt-rail"

const base = {
  sessionID: "session",
  createdAt: "2026-01-01T00:00:00.000Z",
  time: { created: 1 },
}

const user = (id: string): Message => ({ ...base, id, role: "user" })
const assistant = (id: string, parentID: string): Message => ({ ...base, id, parentID, role: "assistant" })
const text = (id: string, messageID: string, value: string, synthetic = false): Part =>
  ({ id, messageID, type: "text", text: value, synthetic }) as TextPart
const lookup = (values: Record<string, Part[]>) => (id: string) => values[id] ?? []

describe("previewText", () => {
  it("collapses whitespace and removes markdown decoration", () => {
    expect(previewText("# Title\n- one\n> two\nthree")).toBe("Title one two three")
  })

  it("drops code, link URLs, and images", () => {
    expect(previewText("before `code` [docs](https://example.com) ![shot](img.png) after")).toBe("before docs after")
  })
})

describe("promptItems", () => {
  it("creates prompt and aggregated answer previews per turn", () => {
    const u1 = user("u1")
    const a1 = assistant("a1", "u1")
    const a2 = assistant("a2", "u1")
    const parts = {
      u1: [text("up1", "u1", "add authentication")],
      a1: [text("ap1", "a1", "First answer.")],
      a2: [text("ap2", "a2", "Second answer.")],
    }

    expect(promptItems(messageTurns([u1, a1, a2]), lookup(parts))).toEqual([
      {
        key: "u1",
        turn: "u1",
        queued: false,
        prompt: "add authentication",
        answer: "First answer. Second answer.",
        promoted: false,
      },
    ])
  })

  it("marks queued prompts and ignores synthetic text", () => {
    const u1 = user("u1")
    const parts = { u1: [text("up1", "u1", "visible"), text("up2", "u1", "hidden", true)] }

    expect(promptItems(messageTurns([u1]), lookup(parts), new Set(["u1"]))[0]).toMatchObject({
      queued: true,
      prompt: "visible",
    })
  })

  it("leaves the answer empty for tool-only turns", () => {
    const u1 = user("u1")
    const a1 = assistant("a1", "u1")
    const parts = {
      u1: [text("up1", "u1", "run tests")],
      a1: [
        {
          id: "at1",
          messageID: "a1",
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: {}, output: "done", title: "Run tests" },
        } as Part,
      ],
    }

    expect(promptItems(messageTurns([u1, a1]), lookup(parts))[0]).toMatchObject({
      prompt: "run tests",
      answer: "",
    })
  })

  it("promotes the answer for image-only prompts", () => {
    const u1 = user("u1")
    const a1 = assistant("a1", "u1")
    const parts = {
      u1: [{ id: "up1", messageID: "u1", type: "file", mime: "image/png", url: "data:," } as Part],
      a1: [text("ap1", "a1", "The screenshot shows the navigation rail.")],
    }

    expect(promptItems(messageTurns([u1, a1]), lookup(parts))[0]).toMatchObject({
      prompt: "The screenshot shows the navigation rail.",
      answer: "",
    })
  })

  it("truncates long prompt and answer previews", () => {
    const u1 = user("u1")
    const a1 = assistant("a1", "u1")
    const parts = { u1: [text("up1", "u1", "x".repeat(400))], a1: [text("ap1", "a1", "y".repeat(400))] }
    const item = promptItems(messageTurns([u1, a1]), lookup(parts))[0]!

    expect(item.prompt.length).toBe(160)
    expect(item.answer.length).toBe(220)
    expect(item.prompt.endsWith("…")).toBe(true)
    expect(item.answer.endsWith("…")).toBe(true)
  })

  it("keeps an empty fallback item when neither side has text", () => {
    const u1 = user("u1")

    expect(promptItems(messageTurns([u1]), lookup({}))[0]).toMatchObject({ prompt: "", answer: "" })
  })

  it("preserves unchanged item identity across reactive updates", () => {
    const u1 = user("u1")
    const u2 = user("u2")
    const parts = {
      u1: [text("up1", "u1", "first")],
      u2: [text("up2", "u2", "second")],
    }
    const turns = messageTurns([u1, u2])
    const first = promptItems(turns, lookup(parts))
    parts.u2[0] = text("up2", "u2", "updated")
    const second = promptItems(turns, lookup(parts), new Set(), first)

    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]?.prompt).toBe("updated")
  })
})

describe("capacity", () => {
  it("counts ticks using their minimum spacing", () => {
    expect(capacity(24 + 7 * 5)).toBe(5)
    expect(capacity(724)).toBe(100)
    expect(capacity(0)).toBeLessThan(1)
  })
})

describe("historyAction", () => {
  it("loads while history remains, jumps after the final page, and stops without progress", () => {
    expect(historyAction(80, 160, true)).toBe("load")
    expect(historyAction(160, 200, false)).toBe("jump")
    expect(historyAction(160, 160, true)).toBe("stop")
  })
})

describe("railEntries", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    key: `k${index}`,
    turn: `t${index}`,
    queued: false,
    prompt: `p${index}`,
    answer: `a${index}`,
    promoted: false,
  }))

  it("passes through when every prompt fits", () => {
    expect(railEntries(items, 5)).toEqual(items.map((item, index) => ({ type: "prompt", item, index })))
  })

  it("summarizes hidden prompts and reserves unloaded history", () => {
    expect(railEntries(items, 4, true)).toEqual([
      { type: "history" },
      { type: "overflow", count: 3, index: 0 },
      { type: "prompt", item: items[3], index: 3 },
      { type: "prompt", item: items[4], index: 4 },
    ])
  })

  it("keeps the first and latest prompt at minimal capacity", () => {
    expect(railEntries(items, 2)).toEqual([
      { type: "prompt", item: items[0], index: 0 },
      { type: "prompt", item: items[4], index: 4 },
    ])
    expect(railEntries(items, 2, true)).toEqual([{ type: "history" }, { type: "prompt", item: items[4], index: 4 }])
  })

  it("returns no entries when the transcript is unmeasured", () => {
    expect(railEntries(items, 0)).toEqual([])
  })

  it("preserves unchanged entry identity", () => {
    const first = railEntries(items, 4, true)
    const second = railEntries(items, 4, true, first)

    expect(second.every((entry, index) => entry === first[index])).toBe(true)
  })
})
