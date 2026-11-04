/**
 * 全链路耗时探针（webview 侧）。
 *
 * 与 CLI / 扩展宿主使用同一套 traceId 算法：
 *   FNV-1a(`${sessionID}:${messageID}:${partID}`)
 * 所以同一条 part 的三段日志可以按 ID 对上，直接看出瓶颈在哪一段：
 *
 *   [链路][a1b2c3d4] ⑥ webview收到 类型=partUpdated
 *   [链路][a1b2c3d4] ⑦ store写入完成 耗时=1.2ms
 *   [链路][a1b2c3d4] ⑧ 渲染完成 距收到=16ms 帧耗时=16.2ms
 *   [链路][a1b2c3d4] 汇总 扩展→webview=12ms 应用=1.2ms 渲染=16ms
 *
 * 开关：默认开启；控制台执行 __testagentLatency.off() 可关闭，.on() 重新开启。
 */

type Record0 = {
  id: string
  receivedAt?: number
  appliedAt?: number
  renderedAt?: number
  receivedFromExtension?: number
}

const KEY = "testagent.latency"

function detect(): boolean {
  if (typeof window === "undefined") return false
  const flag = (globalThis as { __TESTAGENT_LATENCY__?: boolean }).__TESTAGENT_LATENCY__
  if (flag === false) return false
  if (flag === true) return true
  // 默认开启；只有显式写入 "0" 才关闭（__testagentLatency.off()）
  return window.localStorage?.getItem(KEY) !== "0"
}

let on = detect()
const records = new Map<string, Record0>()
const MAX = 2000

const stampKeys = new Set<string>()

function hash(key: string): string {
  let value = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    value ^= key.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0).toString(16).padStart(8, "0")
}

let seq = 0

/**
 * 没有 part 标识的消息（sessionCreated / commandsLoaded / sessionStatus …）不能
 * 都退化成 hash("::")，否则所有事件共用一个 traceId，日志会串成一团。
 * 这类事件用自增序号，保证每条独立。
 */
function keyOf(input: { sessionID?: string; messageID?: string; partID?: string }): string {
  if (!input.sessionID && !input.messageID && !input.partID) return `#${++seq}`
  return `${input.sessionID ?? ""}:${input.messageID ?? ""}:${input.partID ?? ""}`
}

export function enabled(): boolean {
  return on
}

function num(value: number): string {
  if (value < 1) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return String(Math.round(value))
}

function log(id: string, stage: string, detail: string): void {
  console.log(`[链路][${id}] ${stage} ${detail}`)
}

function slot(sessionID?: string, messageID?: string, partID?: string) {
  const key = keyOf({ sessionID, messageID, partID })
  const id = hash(key)
  let record = records.get(key)
  if (!record) {
    if (records.size >= MAX) {
      const first = records.keys().next().value
      if (first) records.delete(first)
    }
    record = { id }
    records.set(key, record)
  }
  return { key, record }
}

/** ⑥ webview 收到扩展消息（带上扩展侧转发时刻，用于算 ⑤→⑥） */
export function markReceive(input: {
  sessionID?: string
  messageID?: string
  partID?: string
  type: string
  sentAt?: number
}): string {
  const { record } = slot(input.sessionID, input.messageID, input.partID)
  const now = performance.now()
  record.receivedAt = now
  // 扩展侧用 Date.now()(epoch)，这里用 performance.now()(页面相对时间)，
  // 直接相减会得到天文数字。换算到同一时钟域后再算传输耗时。
  record.receivedFromExtension =
    input.sentAt === undefined ? undefined : now - (Date.now() - input.sentAt)
  if (!on) return record.id
  log(record.id, "⑥ webview收到", `类型=${input.type}`)
  return record.id
}

/** ⑦ store 写入完成 */
export function markApplied(input: unknown): void {
  if (!on) return
  const id = identityOf(input)
  const { record } = slot(id.sessionID, id.messageID, id.partID)
  record.appliedAt = performance.now()
  const since = record.receivedAt === undefined ? undefined : record.appliedAt - record.receivedAt
  log(record.id, "⑦ store写入完成", `类型=${id.type}${since === undefined ? "" : ` 耗时=${num(since)}ms`}`)
}

/**
 * ⑧ 渲染完成：用两帧 rAF 近似"DOM 已提交并完成布局/绘制"。
 * 每帧只汇总一次，避免同一帧内多条消息各算一次。
 */
const pendingRender = new Set<string>()

export function markRender(input: unknown): void {
  if (!on) return
  const id = identityOf(input)
  const { key, record } = slot(id.sessionID, id.messageID, id.partID)
  if (pendingRender.has(key)) return
  pendingRender.add(key)

  const frameStart = performance.now()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      pendingRender.delete(key)
      if (record.renderedAt !== undefined) return
      record.renderedAt = performance.now()
      const sinceReceive = record.receivedAt === undefined ? undefined : record.renderedAt - record.receivedAt
      const frame = record.renderedAt - frameStart
      log(record.id, "⑧ 渲染完成", `距收到=${num(sinceReceive ?? 0)}ms 帧耗时=${num(frame)}ms`)

      const parts: string[] = []
      if (sinceReceive !== undefined) parts.push(`收到→渲染=${num(sinceReceive)}ms`)
      if (record.appliedAt !== undefined) parts.push(`store应用=${num(record.appliedAt - (record.receivedAt ?? record.appliedAt))}ms`)
      if (record.receivedFromExtension !== undefined && record.receivedAt !== undefined)
        parts.push(`扩展→webview=${num(record.receivedAt - record.receivedFromExtension)}ms`)
      if (parts.length) log(record.id, "汇总", parts.join(" "))
    })
  })
}

export const latency = {
  get enabled() {
    return on
  },
  on(): void {
    on = true
    window.localStorage?.setItem(KEY, "1")
    console.log("[链路] webview 探针已开启")
  },
  off(): void {
    on = false
    window.localStorage?.setItem(KEY, "0")
    console.log("[链路] webview 探针已关闭")
  },
  reset(): void {
    records.clear()
    stampKeys.clear()
  },
}

declare global {
  interface Window {
    __testagentLatency?: typeof latency
  }
}

// testagent_change start - 汇总回传通道:由 VSCodeProvider 注入,用于落盘成文件
let sender: ((payload: { rows: RenderRow[]; at: number }) => void) | undefined

export function attachStatsSender(fn: (payload: { rows: RenderRow[]; at: number }) => void): void {
  sender = fn
}

if (typeof window !== "undefined") {
  window.__testagentLatency = latency
  // 每 5s 打印一次渲染耗时排名,并回传给扩展宿主落盘
  setInterval(() => {
    if (!on) return
    const rows = dumpRenderStats()
    if (!rows.length) return
    sender?.({ rows, at: Date.now() })
    resetRenderStats()
  }, 5000)
}
// testagent_change end

/** 从扩展消息体里提取 part 标识（与 CLI/扩展侧 traceId 规则一致） */
type MessageLike = {
  type?: string
  sessionID?: string
  messageID?: string
  part?: { id?: string; messageID?: string }
  message?: { id?: string }
}

export function identityOf(message: unknown): { sessionID?: string; messageID?: string; partID?: string; type: string } {
  const msg = (message ?? {}) as MessageLike
  return {
    sessionID: msg.sessionID,
    messageID: msg.messageID ?? msg.part?.messageID ?? msg.message?.id,
    partID: msg.part?.id,
    type: msg.type ?? "<unknown>",
  }
}

// ============================================
// 组件级渲染探针
// ============================================
//
// 用于回答"一次渲染 30~49ms 到底花在哪个组件上"。
// 用法：在组件 body 里调用 `measureRender("组件名")`，它会在 onMount 记录
// 首次渲染耗时，并在后续每次响应式更新后（微任务里）记录一次耗时。
//
// 输出：
//   [渲染][AssistantMessage] 首次挂载=12.4ms
//   [渲染][Markdown] 更新=8.2ms

const renderBudget = new Map<string, { total: number; count: number; max: number }>()

/** 记录一次组件渲染耗时 */
export function recordRender(name: string, elapsed: number, kind: "首次挂载" | "更新"): void {
  if (!on) return
  const entry = renderBudget.get(name) ?? { total: 0, count: 0, max: 0 }
  entry.total += elapsed
  entry.count += 1
  if (elapsed > entry.max) entry.max = elapsed
  renderBudget.set(name, entry)
  // 超过 4ms 的渲染才打印，避免刷屏
  if (elapsed >= 4) log("-", `[渲染]${name}`, `${kind}=${num(elapsed)}ms`)
}

/** 周期性打印渲染汇总（按总耗时排序） */
export type RenderRow = { name: string; count: number; total: number; avg: number; max: number }

export function renderStats(): RenderRow[] {
  return [...renderBudget.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, e]) => ({
      name,
      count: e.count,
      total: Math.round(e.total * 10) / 10,
      avg: Math.round((e.total / e.count) * 10) / 10,
      max: Math.round(e.max * 10) / 10,
    }))
}

export function dumpRenderStats(): RenderRow[] {
  if (!on) return []
  const rows = renderStats()
  if (!rows.length) return []
  console.log("[渲染汇总] 组件 次数 总耗时 均值 峰值")
  for (const e of rows.slice(0, 15)) {
    console.log(`[渲染汇总] ${e.name} ${e.count}次 总${e.total}ms 均${e.avg}ms 峰${e.max}ms`)
  }
  return rows
}

export function resetRenderStats(): void {
  renderBudget.clear()
}

/** 供 packages/ui 的 markdown 组件上报分阶段耗时 */
export function recordPhase(name: string, elapsed: number): void {
  recordRender(name, elapsed, "更新")
}

declare global {
  interface Window {
    __TESTAGENT_PERF_TIME__?: (name: string, ms: number) => void
  }
}

if (typeof window !== "undefined") window.__TESTAGENT_PERF_TIME__ = recordPhase

/**
 * 在组件 body 中调用，测量该组件每次渲染的同步耗时。
 *
 *   const stop = measureRender("AssistantMessage")
 *   ... 组件逻辑 ...
 *   stop()          // 手动结束（可选）
 *
 * 简化用法（推荐）：直接在组件 body 首行调用 `trackRender("组件名")`，
 * 它会自动在 onMount 与每次 effect 更新后上报耗时。
 */
export function trackRender(name: string): void {
  if (!on) return
  const start = performance.now()
  let first = true
  // queueMicrotask 在本轮同步渲染结束后执行，可测到本次更新的真实耗时
  queueMicrotask(() => {
    recordRender(name, performance.now() - start, first ? "首次挂载" : "更新")
    first = false
  })
}
