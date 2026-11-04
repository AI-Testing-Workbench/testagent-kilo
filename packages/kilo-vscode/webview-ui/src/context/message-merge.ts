/**
 * 消息字段级合并。
 *
 * 扩展在每个 `message.updated` 都会重发完整消息。之前 webview 用
 * `{...msgs[idx], ...message}` 写入 store，会替换整个 message 对象的引用，
 * 导致 `<For each={turn.assistant}>` 认为这是一个新元素：
 * `AssistantMessage` 被销毁重建，其内部所有 part 组件、Markdown 解析、
 * Shiki 高亮全部重做。（实测 AssistantMessage 单次渲染 155ms / 峰值 246ms。）
 *
 * 这里只返回真正变化的顶层字段，让 Solid 的原生代理继续生效，
 * 从而只更新 `time.completed`、`error`、`tokens` 等真正变化的信号。
 */

type Fields = Record<string, unknown>

/** 浅比较：原始值按值比较，普通对象向下比较一层（覆盖 time / tokens / model）。 */
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) return left === right

  const a = left as Fields
  const b = right as Fields
  const keys = Object.keys(b)
  if (keys.length !== Object.keys(a).length) return false

  for (const key of keys) {
    const value = a[key]
    const next = b[key]
    if (value === next) continue
    if (!value || !next || typeof value !== "object" || typeof next !== "object") return false
    const inner = next as Fields
    const previous = value as Fields
    const innerKeys = Object.keys(inner)
    if (innerKeys.length !== Object.keys(previous).length) return false
    for (const field of innerKeys) if (previous[field] !== inner[field]) return false
  }
  return true
}

/**
 * 对比出变化字段。`parts` 被跳过 —— part 存在独立的 store 分区里。
 * 没有任何变化时返回空对象。
 */
export function mergeMessagePatch(current: Record<string, unknown>, next: Record<string, unknown>): Fields {
  const patch: Fields = {}
  for (const key of Object.keys(next)) {
    if (key === "parts") continue
    if (same(current[key], next[key])) continue
    patch[key] = next[key]
  }
  return patch
}
