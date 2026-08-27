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
  metadata?: { sessionId?: string }
}

/** Minimal tool part shape for timing extraction. */
type TimingTaskPart = {
  id?: string
  type: string
  tool?: string
  metadata?: { sessionId?: string }
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

/** 时间区间并集总时长（ms）：重叠区间只计一次 */
function union(spans: Array<[number, number]>): number {
  return spans
    .sort((a, b) => a[0] - b[0])
    .reduce(
      (sum, span) => ({
        total: sum.total + Math.max(0, span[1] - Math.max(span[0], sum.end)),
        end: Math.max(sum.end, span[1]),
      }),
      { total: 0, end: 0 },
    ).total
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
  busySince: Record<string, number> = {},
): TimingInfo | undefined {
  let llm = 0
  let wait = 0
  let tool = 0
  let permissionWait = 0
  let questionWait = 0
  const toolBreakdown: Record<string, number> = {}
  const seenMessages = new Set<string>()
  const seenParts = new Set<string>()
  const intervals: Array<[number, number]> = []
  // 每条消息的 LLM 流近似区间 [created, created+llm]，用于并行去重
  const llmSpans: Array<[number, number]> = []
  // 工具执行区间，用于并行去重
  const toolSpans: Array<[number, number]> = []
  let has = false

  for (const sid of family) {
    if (busySince[sid]) intervals.push([busySince[sid], Date.now()])
    const msgs = messages[sid] ?? []
    for (const m of msgs) {
      if (m.role !== "assistant" || seenMessages.has(m.id)) continue
      seenMessages.add(m.id)
      // LLM 耗时：按区间并集去重，父子会话并行的流重叠只计一次
      // 每条 assistant 消息约对应一次流，流约从 created 开始、持续 llm 毫秒，不晚于 completed
      const span = m.time?.llm ?? 0
      if (m.time?.created && span > 0) {
        const end = m.time.completed ? Math.min(m.time.completed, m.time.created + span) : m.time.created + span
        llmSpans.push([m.time.created, end])
      }
      if (m.time?.completed && m.time.created) intervals.push([m.time.created, m.time.completed])
      has = true

      // 遍历此消息的 parts，统计等待工具和工具执行耗时
      const pList = parts[m.id] ?? []
      for (const p of pList) {
        if (p.id && seenParts.has(p.id)) continue
        if (p.id) seenParts.add(p.id)
        const child = childID(p)
        if (p.tool === "task" && child && family.has(child)) continue
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
            toolSpans.push([p.state.time.start, p.state.time.end ?? Date.now()])
            if (p.tool) {
              toolBreakdown[p.tool] = (toolBreakdown[p.tool] ?? 0) + dur
            }
          }
        }
      }
    }
    // 累加 permission 等待耗时
    wait += permissionWaits[sid] ?? 0
    permissionWait += permissionWaits[sid] ?? 0
  }

  // 旧会话可能只有 total（从 time.created/computed 算出），但没有 llm/tool/wait 细项
  // 这种情况不展示耗时面板
  if (!has) return undefined

  // LLM/工具按时间区间并集去重：并行/嵌套会话重叠的执行时间只计一次
  llm = union(llmSpans)
  tool = union(toolSpans)
  if (llm === 0) return undefined

  const accumulated = llm + tool + wait
  const elapsed = intervals
    .sort((a, b) => a[0] - b[0])
    .reduce(
      (sum, span) => ({
        total: sum.total + Math.max(0, span[1] - Math.max(span[0], sum.end)),
        end: Math.max(sum.end, span[1]),
      }),
      { total: 0, end: 0 },
    ).total
  const finalTotal = elapsed || accumulated

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
