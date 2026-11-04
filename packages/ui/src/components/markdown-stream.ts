import { marked, Tokens } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live"
}

function refs(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

/**
 * 流式文本切块。
 *
 * 已完成的 token 单独成块并带上稳定 key，可命中 HTML 缓存；最后一块仍在
 * 增长，每次重新解析。逐 token 解析与整体解析在无引用定义时结果一致
 * （已验证），因此拼接后的 HTML 与一次性解析等价。
 *
 * 以下情况退回单块（保证语义绝对正确）：
 *   - 文本含引用式链接 / 脚注定义（定义可出现在末尾，切块会破坏上下文）
 *   - 正在书写未闭合的代码围栏
 *   - lexer 无法切出多个块
 */
export function stream(text: string, live: boolean) {
  if (!live) return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  const src = heal(text)
  if (refs(text)) return [{ raw: text, src, mode: "live" }] satisfies Block[]

  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src, mode: "live" }] satisfies Block[]

  const last = tokens[tail]
  if (!last) return [{ raw: text, src, mode: "live" }] satisfies Block[]

  // 未闭合代码围栏：围栏前的块稳定，围栏本身作为尾部持续重解析
  if (last.type === "code") {
    const code = last as Tokens.Code
    if (open(code.raw)) {
      const head = tokens
        .slice(0, tail)
        .map((token) => token.raw)
        .join("")
      const blocks: Block[] = []
      if (head.trim()) blocks.push({ raw: head, src: heal(head), mode: "live" })
      blocks.push({ raw: code.raw, src: code.raw, mode: "live" })
      return blocks
    }
  }

  // 逐 token 成块：已完成的 token 内容不再变化，可命中 HTML 缓存；
  // 最后一个 token 是仍在增长的尾部，每次重新解析。
  // 逐块解析后拼接与整体解析等价（无引用定义时成立，已单测验证）。
  const blocks: Block[] = []
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!.raw
    if (!raw) continue
    blocks.push({ raw, src: i === tail ? heal(raw) : raw, mode: "live" })
  }

  if (blocks.length === 0) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  return blocks
}

/** 供测试使用 */
export const __internal = { refs, open }
