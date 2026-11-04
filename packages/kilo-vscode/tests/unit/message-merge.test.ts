import { describe, expect, it } from "bun:test"
import { mergeMessagePatch } from "../../webview-ui/src/context/message-merge"

describe("mergeMessagePatch", () => {
  it("只返回真正变化的字段", () => {
    const current = { id: "m1", role: "assistant", time: { created: 1 }, tokens: { input: 10 } }
    const next = { id: "m1", role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 10 } }

    expect(mergeMessagePatch(current, next)).toEqual({ time: { created: 1, completed: 2 } })
  })

  it("没有变化时返回空对象", () => {
    const current = { id: "m1", role: "assistant", time: { created: 1 } }
    const next = { id: "m1", role: "assistant", time: { created: 1 } }

    expect(mergeMessagePatch(current, next)).toEqual({})
  })

  it("跳过 parts 字段（存在独立 store 分区）", () => {
    const current = { id: "m1", role: "assistant" }
    const next = { id: "m1", role: "assistant", parts: [{ id: "p1" }] }

    expect(mergeMessagePatch(current, next)).toEqual({})
  })

  it("识别顶层标量变化", () => {
    expect(mergeMessagePatch({ id: "m1", finish: "tool-calls" }, { id: "m1", finish: "stop" })).toEqual({
      finish: "stop",
    })
  })

  it("识别嵌套计数器变化", () => {
    const current = { id: "m1", tokens: { cache: { read: 1, write: 0 } } }
    const next = { id: "m1", tokens: { cache: { read: 2, write: 0 } } }

    expect(mergeMessagePatch(current, next)).toEqual({ tokens: { cache: { read: 2, write: 0 } } })
  })
})
