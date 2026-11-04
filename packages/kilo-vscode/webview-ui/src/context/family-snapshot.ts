/**
 * familyData 的引用级缓存。
 *
 * DataBridge 在 memo 里构建整份 data 快照交给 DataProvider。此前
 * `familyData` 每次都新建 messages / parts / status 三个对象，于是任何一次
 * part 文本增量都会让快照"看起来变了"，导致下游所有依赖它的 memo 重算。
 *
 * part 的文本变化不改变其数组引用，所以引用比较天然可以作为"结构是否变化"
 * 的判据：流式 token 不会击穿缓存，只有 message/part 新增、删除、替换才会。
 */

export type FamilySnapshot<TMessage, TPart, TStatus> = {
  root: string
  ver: number
  messages: Record<string, TMessage[]>
  parts: Record<string, TPart[]>
  status: Record<string, TStatus>
}

export function familySnapshot<TMessage, TPart, TStatus>(input: {
  root: string
  ver: number
  previous: FamilySnapshot<TMessage, TPart, TStatus> | undefined
  collect: () => {
    messages: Record<string, TMessage[]>
    parts: Record<string, TPart[]>
    status: Record<string, TStatus>
  }
}): FamilySnapshot<TMessage, TPart, TStatus> {
  const previous = input.previous?.root === input.root && input.previous.ver === input.ver ? input.previous : undefined
  const collected = input.collect()
  const messages: Record<string, TMessage[]> = {}
  const parts: Record<string, TPart[]> = {}
  const status: Record<string, TStatus> = {}
  let changed = previous === undefined

  for (const [id, list] of Object.entries(collected.messages)) {
    const prior = previous?.messages[id]
    if (prior !== undefined && prior === list) messages[id] = prior
    else {
      messages[id] = list
      changed = true
    }
  }

  for (const [id, list] of Object.entries(collected.parts)) {
    const prior = previous?.parts[id]
    if (prior !== undefined && prior === list) parts[id] = prior
    else {
      parts[id] = list
      changed = true
    }
  }

  for (const [id, info] of Object.entries(collected.status)) {
    const prior = previous?.status[id]
    if (prior !== undefined && prior === info) status[id] = prior
    else {
      status[id] = info
      changed = true
    }
  }

  if (!changed && previous) return previous
  return { root: input.root, ver: input.ver, messages, parts, status }
}
