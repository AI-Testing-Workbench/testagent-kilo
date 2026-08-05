import type { Part, TokenUsage } from "../types/messages"

/** Minimal message shape for cost breakdown helpers. */
export type CostMessage = { id: string; role: string; cost?: number }

/** Minimal message shape for timing helpers — includes time fields from backend */
export type TimingMessage = {
  id: string
  role: string
  time?: {
    created: number
    completed?: number
    llm?: number
  }
}

/** Tool state shape with time fields for timing computation */
type TimingToolState = {
  status: string
  time?: { start: number; end?: number }
}

/** Minimal tool part shape for timing extraction. */
type TimingTaskPart = {
  type: string
  tool?: string
  state?: TimingToolState
}

/** Minimal tool part shape for label extraction. */
type ToolState = {
  input?: { description?: string; subagent_type?: string }
  metadata?: { sessionId?: string }
}

type TaskPart = {
  type: string
  tool?: string
  metadata?: { sessionId?: string }
  state?: ToolState
}

export function childID(part: TaskPart): string | undefined {
  if (part.type !== "tool" || part.tool !== "task") return undefined
  return part.metadata?.sessionId ?? part.state?.metadata?.sessionId
}

/**
 * Derive a human-readable status string from the last streaming part.
 * Returns undefined for part types that don't map to a status.
 */
export function computeStatus(
  part: Part | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | undefined {
  if (!part) return undefined
  if (part.type === "tool") {
    switch (part.tool) {
      case "task":
        return t("ui.sessionTurn.status.delegating")
      case "todowrite":
      case "todoread":
        return t("ui.sessionTurn.status.planning")
      case "read":
        return t("ui.sessionTurn.status.gatheringContext")
      case "list":
      case "grep":
      case "glob":
        return t("ui.sessionTurn.status.searchingCodebase")
      case "webfetch":
        return t("ui.sessionTurn.status.searchingWeb")
      case "edit":
      case "write":
        return t("ui.sessionTurn.status.makingEdits")
      case "bash":
        return t("ui.sessionTurn.status.runningCommands")
      default:
        return undefined
    }
  }
  if (part.type === "reasoning") return t("ui.sessionTurn.status.thinking")
  if (part.type === "text") return t("session.status.writingResponse")
  return undefined
}

/**
 * Calculate total cost across all assistant messages.
 */
export function calcTotalCost(messages: Array<{ role: string; cost?: number }>): number {
  return messages.reduce((sum, m) => sum + (m.role === "assistant" ? (m.cost ?? 0) : 0), 0)
}

/**
 * Calculate context usage percentage given token counts and a context limit.
 */
export function calcContextUsage(
  tokens: {
    input: number
    output: number
    reasoning?: number
    cache?: { read: number; write: number }
  },
  contextLimit: number | undefined,
): { tokens: number; percentage: number | null } {
  const total =
    tokens.input + tokens.output + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
  const percentage = contextLimit ? Math.round((total / contextLimit) * 100) : null
  return { tokens: total, percentage }
}

/**
 * Build a map of session ID → total cost for each session in the family
 * that has non-zero cost. Pure function — no store dependency.
 */
export function buildFamilyCosts(
  family: Set<string>,
  messages: Record<string, Array<{ role: string; cost?: number }>>,
): Map<string, number> {
  const costs = new Map<string, number>()
  for (const sid of family) {
    const cost = calcTotalCost(messages[sid] ?? [])
    if (cost > 0) costs.set(sid, cost)
  }
  return costs
}

export interface FamilyTokens {
  input: number
  output: number
  reasoning: number
  total?: number
  cache: { read: number; write: number }
  breakdown?: { system: number; messages: number; tools: number }
}

/**
* Accumulate tokens across all assistant messages in a session family.
* Pure function — no store dependency.
*/
export function buildFamilyTokens(
  family: Set<string>,
  messages: Record<string, Array<{ role: string; tokens?: TokenUsage }>>,
): FamilyTokens | undefined {
  const total: FamilyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  let has = false
  let hasTotal = false
  for (const sid of family) {
    for (const m of messages[sid] ?? []) {
      if (m.role !== "assistant" || !m.tokens) continue
      total.input += m.tokens.input
      total.output += m.tokens.output
      total.reasoning += m.tokens.reasoning ?? 0
      total.cache.read += m.tokens.cache?.read ?? 0
      total.cache.write += m.tokens.cache?.write ?? 0
      if (m.tokens.total != null) {
        total.total = (total.total ?? 0) + m.tokens.total
        hasTotal = true
      }
      // Accumulate breakdown per message
      if (m.tokens.breakdown) {
        if (!total.breakdown) total.breakdown = { system: 0, messages: 0, tools: 0 }
        total.breakdown.system += m.tokens.breakdown.system
        total.breakdown.messages += m.tokens.breakdown.messages
        total.breakdown.tools += m.tokens.breakdown.tools
      }
      has = true
    }
  }
  if (!hasTotal) total.total = undefined
  return has ? total : undefined
}

const LABEL_CAP = 24

/**
 * Build a map of child session ID → label by scanning tool parts in the
 * family for task tool metadata. Pure function — no store dependency.
 */
export function buildFamilyLabels(
  family: Set<string>,
  messages: Record<string, CostMessage[]>,
  parts: Record<string, TaskPart[]>,
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const sid of family) {
    const msgs = messages[sid]
    if (!msgs) continue
    for (const msg of msgs) {
      const list = parts[msg.id]
      if (!list) continue
      for (const p of list) {
        if (p.type !== "tool") continue
        const child = childID(p)
        if (!child || !family.has(child)) continue
        const raw = p.state?.input?.subagent_type || p.state?.input?.description || p.tool || "task"
        const desc = raw.length > LABEL_CAP ? raw.slice(0, LABEL_CAP - 2) + "…" : raw
        if (!labels.has(child)) labels.set(child, desc)
      }
    }
  }
  return labels
}

/**
 * Combine costs and labels into the final breakdown array.
 * Pure function — no store dependency.
 */
export function buildCostBreakdown(
  root: string,
  costs: Map<string, number>,
  labels: Map<string, string>,
  rootLabel: string,
): Array<{ label: string; cost: number }> {
  const items: Array<{ label: string; cost: number }> = []
  for (const [sid, cost] of costs) {
    const label = sid === root ? rootLabel : (labels.get(sid) ?? sid.slice(0, 8))
    items.push({ label, cost })
  }
  return items
}

const VISIBLE_CHILDREN = 8

/**
 * Collapse a cost breakdown for display in the tooltip.
 * - The root entry (first item) always stays at the top.
 * - Child entries are shown in reverse order (most recent first).
 * - When there are more than VISIBLE_CHILDREN child entries, the
 *   oldest are aggregated into a single summary line.
 *
 * Pure function — no store dependency.
 */
export function collapseCostBreakdown(
  items: Array<{ label: string; cost: number }>,
  summaryLabel: (count: number) => string,
): Array<{ label: string; cost: number }> {
  const root = items[0]
  const children = items.slice(1)
  const reversed = [...children].reverse()

  if (reversed.length <= VISIBLE_CHILDREN) return [root, ...reversed]

  const visible = reversed.slice(0, VISIBLE_CHILDREN)
  const hidden = reversed.slice(VISIBLE_CHILDREN)
  const aggregated = hidden.reduce((sum, e) => sum + e.cost, 0)
  return [root, ...visible, { label: summaryLabel(hidden.length), cost: aggregated }]
}

// ── Timing ─────────────────────────────────────────────────────

/** Tools that wait for user input */
const WAIT_TOOLS = new Set(["question", "invalid"])

// debug: 模块级缓存 —— 仅当计时统计结果变化时打印明细，避免每 tick 刷屏
let lastTimingDebugSig = ""

export interface TimingInfo {
  total: number  // 总耗时 (ms)
  llm: number    // LLM 总耗时 (ms)
  wait: number   // 等待用户耗时 (ms)
  actual: number // 实际执行耗时 = total - wait (ms)
  tool: number   // 工具执行耗时 (ms)
  permissionWait: number // 权限等待耗时 (ms)
  questionWait: number   // 问题等待耗时 (ms)
  toolBreakdown?: Record<string, number> // 各工具名称的耗时明细
}

export interface TimingSegment {
  key: string
  label: string
  duration: number
  percent: number
  width: number
  color: string
}

/**
 * Compute timing breakdown across a session family.
 * Pure function — no store dependency.
 */
export function buildFamilyTiming(
  family: Set<string>,
  messages: Record<string, TimingMessage[]>,
  parts: Record<string, TimingTaskPart[]>,
  permissionWaits: Record<string, number> = {},
): TimingInfo | undefined {
  let total = 0
  let llm = 0
  let wait = 0
  let tool = 0
  let permissionWait = 0
  let questionWait = 0
  const toolBreakdown: Record<string, number> = {}
  let has = false

  for (const sid of family) {
    const msgs = messages[sid] ?? []
    // debug: 检测本 sid 消息数组内是否有重复 mid（同一 mid 出现多次 → 会被重复累加导致虚高）
    {
      const seenMid = new Map<string, number>()
      for (const m of msgs) {
        if (m.role !== "assistant") continue
        seenMid.set(m.id, (seenMid.get(m.id) ?? 0) + 1)
      }
      const dupMids = [...seenMid.entries()].filter(([, n]) => n > 1)
      if (dupMids.length > 0) {
        console.warn(
          "[timing] duplicate mids in messages:",
          JSON.stringify({ sid, dupMids }),
        )
      }
    }
    for (const m of msgs) {
      if (m.role !== "assistant") continue
      // LLM 耗时
      llm += m.time?.llm ?? 0
      has = true

      // 遍历此消息的 parts，统计等待工具和工具执行耗时
      const pList = parts[m.id] ?? []
      for (const p of pList) {
        if (p.type === "tool" && p.state?.time?.start) {
          const dur = p.state.time.end
            ? p.state.time.end - p.state.time.start
            : Date.now() - p.state.time.start // 运行中的工具实时估算
          if (p.tool && WAIT_TOOLS.has(p.tool)) {
            wait += dur // question/invalid 只算等待，不算工具执行
            if (p.tool === "question") {
              questionWait += dur
            }
          } else {
            tool += dur // 其他正常工具算工具执行
            if (p.tool) {
              toolBreakdown[p.tool] = (toolBreakdown[p.tool] ?? 0) + dur
            }
          }
        }
      }
      // debug: 打印本消息的 tool part 明细 + 去重检测（同一 mid 下同 tool 多个 part 说明 store 有重复）
      {
        const toolParts = pList.filter((p) => p.type === "tool")
        if (toolParts.length > 0) {
          const rows = toolParts.map((p, i) => ({
            i,
            tool: p.tool,
            status: p.state?.status,
            start: p.state?.time?.start ?? null,
            end: p.state?.time?.end ?? null,
            dur: p.state?.time?.start
              ? (p.state.time.end ?? Date.now()) - p.state.time.start
              : null,
          }))
          const sig = JSON.stringify(rows)
          if (sig !== lastTimingDebugSig) {
            lastTimingDebugSig = sig
            // 去重检测：同 tool + 同 start 的 part 出现多次 = 重复入 store
            const seen = new Map<string, number>()
            for (const r of rows) {
              const key = `${r.tool}|${r.start}`
              seen.set(key, (seen.get(key) ?? 0) + 1)
            }
            const dupes = [...seen.entries()].filter(([, n]) => n > 1)
            console.warn(
              "[timing] tool parts:",
              JSON.stringify({
                mid: m.id,
                sid,
                count: rows.length,
                dupes,
                rows,
              }),
            )
          }
        }
      }
    }
    // 累加 permission 等待耗时
    wait += permissionWaits[sid] ?? 0
    permissionWait += permissionWaits[sid] ?? 0
    // 找第一条和最后一条消息的时间确定总耗时
    const first = msgs[0]
    const last = msgs[msgs.length - 1]
    if (first?.role === "user" && first.time?.created && last?.role === "assistant" && last.time?.completed) {
      total = Math.max(total, last.time.completed - first.time.created)
    }
  }

  // 旧会话可能只有 total（从 time.created/computed 算出），但没有 llm/tool/wait 细项
  // 这种情况不展示耗时面板
  if (llm === 0) return undefined

  if (!has) return undefined

  // 总计取累加和与墙上时钟的最大值，保证数据自洽
  // 子会话与父会话时间重叠时，累加和 > 墙上时钟
  const accumulated = llm + tool + wait
  const finalTotal = Math.max(total, accumulated)

  const actual = Math.max(0, finalTotal - wait)

  return { total: finalTotal, llm, wait, actual, tool, permissionWait, questionWait, toolBreakdown }
}

/**
 * Compute timing segments for the breakdown bar display.
 * Segments are: LLM, 工具执行, 等待用户, 其他开销.
 * "实际执行" (total - wait) is only shown in tooltip, not as a bar segment.
 */
export function buildTimingSegments(info: Pick<TimingInfo, "total" | "llm" | "tool" | "wait">): TimingSegment[] {
  const pct = (v: number) => (info.total > 0 ? (v / info.total) * 100 : 0)
  const overhead = Math.max(0, info.total - info.llm - info.tool - info.wait)
  return [
    { key: "llm", label: "LLM", duration: info.llm, percent: pct(info.llm), width: pct(info.llm), color: "var(--syntax-property)" },
    { key: "tool", label: "工具执行", duration: info.tool, percent: pct(info.tool), width: pct(info.tool), color: "var(--syntax-info)" },
    { key: "wait", label: "等待用户", duration: info.wait, percent: pct(info.wait), width: pct(info.wait), color: "var(--syntax-warning, #d2a106)" },
    { key: "overhead", label: "其他开销", duration: overhead, percent: pct(overhead), width: pct(overhead), color: "var(--syntax-muted, #888)" },
  ].filter((s) => s.duration > 0)
}

/**
 * Format milliseconds to a human-readable duration string.
 */
export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "0s"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m ${s}s`
}
