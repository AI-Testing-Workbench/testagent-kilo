/**
 * 全链路耗时探针（扩展宿主侧）。
 *
 * 对应 CLI 侧 `src/testagent/latency.ts` 的 traceId 规则：
 *   traceId = FNV-1a(`${sessionID}:${messageID}:${partID}`)
 * 两端用同一个算法，所以同一 part 的日志可以按 ID 对上。
 *
 * 打印：
 *   [链路][a1b2c3d4] ④ 扩展收到SSE 距上一环=12ms 类型=message.part.updated
 *   [链路][a1b2c3d4] ⑤ 扩展转发webview 耗时=0ms 类型=partUpdated
 *
 * 开关：默认开启；设置 TESTAGENT_LATENCY=0 可关闭。
 */

const ENABLED = process.env.TESTAGENT_LATENCY !== "0"

type Stamp = { id: string; at: number }

const stamps = new Map<string, Stamp>()
const MAX = 2000

export function enabled(): boolean {
  return ENABLED
}

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
 * 无 part 标识的消息（sessionCreated / commandsLoaded …）用自增序号，
 * 否则会全部退化成 hash("::") 共用一个 traceId，还会误命中别的事件的
 * 时间戳，算出"距收到SSE=8654ms"这类假数据。
 */
function keyOf(sessionID?: string, messageID?: string, partID?: string): string {
  if (!sessionID && !messageID && !partID) return `#${++seq}`
  return `${sessionID ?? ""}:${messageID ?? ""}:${partID ?? ""}`
}

export function idOf(sessionID?: string, messageID?: string, partID?: string): string {
  return hash(keyOf(sessionID, messageID, partID))
}

function num(value: number): string {
  if (value < 1) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return String(Math.round(value))
}

function log(traceId: string, stage: string, detail: string): void {
  console.log(`[链路][${traceId}] ${stage} ${detail}`)
}

/** ④ 扩展收到 SSE 事件 */
export function markReceive(input: {
  sessionID?: string
  messageID?: string
  partID?: string
  type: string
  at?: number
}): string | undefined {
  if (!ENABLED) return undefined
  const key = keyOf(input.sessionID, input.messageID, input.partID)
  // 无 part 标识的转发（commandsLoaded / yoloStatus / workspaceDirectoryChanged …）
  // 与渲染链路无关，不打印，避免刷屏
  if (key.startsWith("#")) return
  const id = hash(key)
  const at = input.at ?? Date.now()
  if (stamps.size >= MAX) {
    const first = stamps.keys().next().value
    if (first) stamps.delete(first)
  }
  stamps.set(key, { id, at })
  log(id, "④ 扩展收到SSE", `类型=${input.type}`)
  return id
}

/** ⑤ 扩展把消息转发给 webview */
export function markForward(input: {
  sessionID?: string
  messageID?: string
  partID?: string
  type: string
  at?: number
}): void {
  if (!ENABLED) return
  const key = keyOf(input.sessionID, input.messageID, input.partID)
  const id = hash(key)
  const at = input.at ?? Date.now()
  // 只有同一条 part 的接收时间才有意义；无标识消息不参与差值计算。
  // 转发后清掉 stamp：调度器会把多次 delta 合并成一次发送，若保留旧时间戳，
  // 下一次发送会算出"距收到SSE=10780ms"这类跨轮次的假数字。
  const prior = key.startsWith("#") ? undefined : stamps.get(key)
  const since = prior ? at - prior.at : undefined
  stamps.delete(key)
  log(
    id,
    "⑤ 扩展转发webview",
    `类型=${input.type}${since === undefined ? "" : ` 距收到SSE=${num(since)}ms`}`,
  )
}

/** 供 postMessage 使用：从 webview 消息体里尽力提取 part 标识 */
export function identityOf(message: unknown): { sessionID?: string; messageID?: string; partID?: string } {
  if (!message || typeof message !== "object") return {}
  const msg = message as {
    sessionID?: string
    messageID?: string
    part?: { id?: string; messageID?: string }
    message?: { id?: string }
  }
  return {
    sessionID: msg.sessionID,
    messageID: msg.messageID ?? msg.part?.messageID ?? msg.message?.id,
    partID: msg.part?.id,
  }
}
