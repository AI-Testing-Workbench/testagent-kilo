// testagent_change - new file
/**
 * 子会话 parts 裁剪。
 *
 * webview 会为每个被打开过的子会话常驻整份 messages/parts。长时间、多子代理
 * 的任务里这部分只增不减。内存压力下把不可见会话里"体积随命令输出增长"的
 * 字段裁到头部摘要,但保留 part 对象本身:
 *
 * - part 的 id/type/status/tool/input 都还在,渲染结构不变;
 * - text / reasoning 正文保留,历史缩略条(prompt-rail)仍能读到摘要;
 * - 只裁 tool 的 output 与 metadata.output,保留前 KEEP 字符 + 截断标记。
 *
 * 保留头部而不是清空,是因为被裁剪的消息在切回会话后不一定能重新拉取:
 * focus 的 reconcile 只覆盖最新一页,prepend 只覆盖更早的历史。保留头部
 * 至少让用户看到命令输出开头和"已截断"提示。
 *
 * 纯函数,不依赖 Solid 与 vscode,便于单测。
 */

/** 保留的头部字符数,与 slim-metadata 的 OUTPUT_CAP 对齐。 */
const KEEP = 4000

const OUTPUT_KEYS = ["output", "result", "stdout", "stderr"] as const

type Rec = Record<string, unknown>

function isObj(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function shrink(value: string): string {
  if (value.length <= KEEP) return value
  return `${value.slice(0, KEEP)}\n… (truncated, ${value.length - KEEP} chars released)`
}

/**
 * 已裁剪过的值长度会略超 KEEP(多了截断标记),不能只按长度判断,
 * 否则第二次裁剪会把标记也一起截掉,变成非幂等。
 */
function pruned(value: string): boolean {
  return value.endsWith("chars released)")
}

function pruneState(state: Rec): { next: Rec; freed: number } {
  let freed = 0
  const next = { ...state }

  for (const key of OUTPUT_KEYS) {
    const value = next[key]
    if (typeof value !== "string" || value.length <= KEEP || pruned(value)) continue
    freed += value.length - KEEP
    next[key] = shrink(value)
  }

  const meta = next.metadata
  if (isObj(meta)) {
    let touched = false
    const slim: Rec = { ...meta }
    for (const key of OUTPUT_KEYS) {
      const value = slim[key]
      if (typeof value !== "string" || value.length <= KEEP || pruned(value)) continue
      freed += value.length - KEEP
      slim[key] = shrink(value)
      touched = true
    }
    if (touched) next.metadata = slim
  }

  return { next, freed }
}

export interface PruneResult {
  parts: unknown[]
  freed: number
  changed: boolean
}

/**
 * 裁掉 tool part 的大输出。非 tool part 原样返回(可能是同一引用)。
 * 没有任何可裁剪内容时返回原数组,调用方可据此跳过 setState。
 */
export function pruneParts(parts: unknown[]): PruneResult {
  let freed = 0
  let changed = false
  const out = parts.map((part) => {
    if (!isObj(part) || part.type !== "tool") return part
    const state = part.state
    if (!isObj(state)) return part
    const result = pruneState(state)
    if (result.freed === 0) return part
    freed += result.freed
    changed = true
    return { ...part, state: result.next }
  })
  return { parts: changed ? out : parts, freed, changed }
}
