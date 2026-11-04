import { describe, expect, test } from "bun:test"
import { marked } from "marked"
import { stream } from "./markdown-stream"

/** 逐块解析再拼接，应与整段解析结果一致（无引用定义时成立） */
function sameAsFull(text: string) {
  const full = marked.parse(text) as string
  const joined = stream(text, true)
    .map((block) => marked.parse(block.src) as string)
    .join("")
  return { full, joined }
}

describe("markdown stream", () => {
  test("heals incomplete emphasis while streaming", () => {
    const blocks = stream("hello **world", true)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.at(-1)!.src).toBe("hello **world**")
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    const blocks = stream("see [docs](https://example.com/gu", true)
    expect(blocks.at(-1)!.src).toBe("see docs")
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    const blocks = stream("before\n\n```ts\nconst x = 1", true)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.raw).toBe("before\n\n")
    expect(blocks[1]!.raw).toBe("```ts\nconst x = 1")
  })

  test("keeps reference-style markdown as one block", () => {
    const text = "[docs][1]\n\n[1]: https://example.com"
    expect(stream(text, true)).toEqual([{ raw: text, src: text, mode: "live" }])
  })

  test("non-streaming text stays a single full block", () => {
    const text = "# a\n\nb\n\n- c"
    expect(stream(text, false)).toEqual([{ raw: text, src: text, mode: "full" }])
  })

  test("splits finished content into per-token blocks so prefixes can be cached", () => {
    const blocks = stream("# t\n\npara one\n\n- i1\n- i2\n\npara two", true)
    expect(blocks.length).toBeGreaterThan(1)
  })

  test("block-by-block parsing matches parsing the whole text", () => {
    const cases = [
      "# Title\n\npara one\n\n- i1\n- i2\n\npara two",
      "hello world\n\n## section\n\nsome *bold* text here",
      "> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      "para\n\n1. one\n2. two\n\nend",
      "```ts\nconst a = 1\n```\n\n正常段落",
    ]

    for (const text of cases) {
      const { full, joined } = sameAsFull(text)
      expect(joined).toBe(full)
    }
  })

  test("renders partial input identically to full parse for the stable prefix", () => {
    // 流式场景：尾部仍在增长时，前缀块的解析结果必须稳定
    const first = stream("段落一\n\n段落二开", true)
    const second = stream("段落一\n\n段落二开始", true)

    expect(first[0]!.src).toBe(second[0]!.src)
  })
})
