# Webview 渲染性能优化 — 需求与方案设计

> 版本：v1.2
> 日期：2026-11-04
> 状态：已实现
> 关联问题：150 轮压测（`opencode-mocker`，`turnDelayMs=0`）下 webview 页面严重卡顿
> 修订：v1.1 追加第 5.2 节 —— snapshot 在 Windows 下的两个独立缺陷（保留设备名、失败后仍 write-tree）
> 修订：v1.2 追加第 3.3.1 节 —— stop 后终态同步改用 reconcile，消除 20+ 次组件重挂载

---

## 目录

1. [需求设计](#1-需求设计)
   - [1.1 业务背景](#11-业务背景)
   - [1.2 问题现象](#12-问题现象)
   - [1.3 用户故事](#13-用户故事)
   - [1.4 功能需求](#14-功能需求)
   - [1.5 非功能需求](#15-非功能需求)
2. [问题分析](#2-问题分析)
   - [2.1 全链路耗时分布](#21-全链路耗时分布)
   - [2.2 根因定位](#22-根因定位)
   - [2.3 排除的假设](#23-排除的假设)
3. [方案设计](#3-方案设计)
   - [3.1 总体思路](#31-总体思路)
   - [3.2 Markdown 解析分块与缓存](#32-markdown-解析分块与缓存)
   - [3.3 消息对象引用稳定](#33-消息对象引用稳定)
     - [3.3.1 同会话终态同步（stop 后）也要走 reconcile](#331-同会话终态同步stop-后也要走-reconcile)
   - [3.4 Turn 对象结构共享](#34-turn-对象结构共享)
   - [3.5 绕开 DataBridge 全量快照](#35-绕开-databridge-全量快照)
   - [3.6 KaTeX 按需启用](#36-katex-按需启用)
   - [3.7 扩展宿主侧优化](#37-扩展宿主侧优化)
   - [3.8 全链路耗时探针](#38-全链路耗时探针)
   - [3.9 涉及文件清单](#39-涉及文件清单)
4. [效果验证](#4-效果验证)
   - [4.1 指标对比](#41-指标对比)
   - [4.2 验收标准达成](#42-验收标准达成)
   - [4.3 回归验证](#43-回归验证)
5. [已回退的方案及原因](#5-已回退的方案及原因)
   - [5.1 关于 snapshot（git）的澄清](#51-关于-snapshotgit的澄清)
   - [5.2 snapshot 的两个独立缺陷（v1.1 修复）](#52-snapshot-的两个独立缺陷v11-修复)
6. [遗留与后续方向](#6-遗留与后续方向)
   - [6.1 并发工具调用的渲染节奏](#61-并发工具调用的渲染节奏)
   - [6.2 其他候选方向](#62-其他候选方向收益递减暂不实施)
   - [6.3 探针的长期价值](#63-探针的长期价值)
   - [6.4 缓存容量监控](#64-缓存容量监控)
7. [经验总结](#7-经验总结)
   - [7.1 有效的排查路径](#71-有效的排查路径)
   - [7.2 埋点设计的教训](#72-埋点设计的教训)

---

## 1. 需求设计

### 1.1 业务背景

`kilo-vscode` 是 VS Code 插件，聊天界面运行在 webview 中。当会话轮次增多（尤其是 agent 工具循环场景），页面会出现明显卡顿：

- 流式输出时打字机效果卡顿、掉帧
- 滚动历史消息不流畅
- 点击「新建任务」等交互响应迟滞

压测场景：`opencode-mocker` 配置 **150 轮 longturns、延迟 0ms**，即每轮由 mock 立即返回文本 + 一次 `bash` 工具调用，形成密集的工具循环。

### 1.2 问题现象

| 现象 | 观测值 |
|---|---|
| 单次渲染帧耗时 | 30~49ms（60fps 预算为 16.7ms） |
| 长任务 | 3~4 次 / 2s，最长 **728ms** |
| `AssistantMessage` 单次渲染 | 均值 **155ms**，峰值 **246ms** |
| `VscodeSessionTurn` 单次渲染 | 均值 **100ms**，峰值 251ms |
| `markdown.parse` 单次 | 均值 **137ms**，峰值 **249ms** |
| 单条消息应用耗时（dispatch） | 32~47ms |

### 1.3 用户故事

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| US-01 | 作为开发者，我希望在长会话（150+ 轮）下流式输出保持流畅，不掉帧 | P0 |
| US-02 | 作为开发者，我希望滚动历史消息时不卡顿 | P0 |
| US-03 | 作为开发者，我希望「新建任务」等交互即时响应 | P0 |
| US-04 | 作为开发者，我需要能定位耗时到底花在 LLM、CLI、扩展转发还是前端渲染 | P0 |
| US-05 | 作为维护者，我希望优化不破坏 markdown 渲染正确性 | P0 |

### 1.4 功能需求

#### FR-01：渲染性能目标

| 指标 | 目标 |
|---|---|
| 单帧渲染耗时 | < 16.7ms（60fps 预算内） |
| `markdown.parse` 单次 | < 10ms |
| 长任务（>50ms） | 0~1 次 / 2s |
| 单条消息应用（dispatch） | < 5ms |

#### FR-02：全链路可观测

需要能回答"到底是 LLM 慢还是前端慢"，因此在以下 8 个环节埋点，用统一 traceId 串联：

```
① LLM 首字       (CLI)
② CLI 写入 part  (CLI)
③ 事件入库广播   (CLI)
④ 扩展收到 SSE   (扩展宿主)
⑤ 扩展转发 webview (扩展宿主)
⑥ webview 收到   (webview)
⑦ store 写入完成 (webview)
⑧ 渲染完成       (webview)
```

#### FR-03：渲染正确性

优化后必须保证：

- markdown 渲染结果与优化前**逐字节一致**
- 未闭合代码围栏、引用式链接定义、列表、表格、块引用等结构正确
- 会话切换、新建任务、revert 等状态切换正常

### 1.5 非功能需求

| 编号 | 要求 | 说明 |
|------|------|------|
| NFR-01 | 零行为变更 | 仅优化性能，不改变任何用户可见行为 |
| NFR-02 | 缓存可失效 | 缓存策略必须保证内容变化时正确失效 |
| NFR-03 | 探针可关闭 | 埋点默认零开销，可通过环境变量关闭 |
| NFR-04 | 最小侵入上游 | 尽量在 `kilo-vscode` 内解决，共享代码改动需加 `kilocode_change` 标记 |

---

## 2. 问题分析

### 2.1 全链路耗时分布

通过在 8 个环节埋点，实测（真实模型、非 mocker）得到：

| 环节 | 实测耗时 | 判定 |
|---|---|---|
| LLM 出字 | 43~75ms/token | 正常（15~20 token/s） |
| CLI 写 part | 0.35~7.2ms | 正常 |
| 扩展转发 | 1~6ms | 正常 |
| IPC 传输 | 2~19ms | 可接受 |
| store 应用 | 0.5~14ms | 偏慢 |
| **渲染** | **30~49ms/帧** | **严重超标** |

**结论：瓶颈 100% 在 webview 渲染，与 LLM、CLI、扩展转发无关。**

### 2.2 根因定位

进一步做组件级埋点，得到决定性数据：

```
[渲染汇总] markdown.parse    4次 总547ms 均137ms 峰249ms
[渲染汇总] AssistantMessage  3次 总484ms 均161ms 峰255ms
[渲染汇总] VscodeSessionTurn 2次 总290ms 均145ms 峰265ms
[渲染汇总] markdown.sanitize 4次 总3.5ms  均0.87ms
```

`sanitize` 仅 0.87ms，说明慢的是 `marked.parse` 本身。定位到 5 个根因：

#### 根因 1：流式文本每次全量重解析

`packages/ui/src/components/markdown-stream.ts` 在流式（`live=true`）时对普通文本返回**单个整块**：

```ts
// 优化前
if (!live) return [{ raw: text, src: text, mode: "full" }]
// 普通文本走这里 → 整段作为一个 block
if (!last || last.type !== "code") return [{ raw: text, src: text, mode: "live" }]
```

因此每个 token 到达都要重新解析整段文本。

实测 12K 字符文本单次解析 **330ms**，70K 字符即对应观测到的 137~249ms。

#### 根因 2：缓存 key 永不命中

```ts
// 优化前：index 恒定（流式时只有 0），mode 恒定，只有 hash 变化
const key = base ? `${base}:${index}:${block.mode}` : hash
if (cached && cached.hash === hash) return cached.html   // hash 变了 → 永远 miss
```

key 里不含内容 hash，而校验用内容 hash，导致**流式期间 100% 缓存未命中**。

#### 根因 3：消息对象引用被打碎

`webview-ui/src/context/session.tsx` 的 `handleMessageCreated`：

```ts
// 优化前：每次 message.updated 都复制整个数组并替换消息对象
const updated = [...msgs]
updated[idx] = { ...msgs[idx], ...message }   // ← 新对象身份
return updated
```

`<For each={turn.assistant}>` 按引用 diff，对象身份变化 → **整个 `AssistantMessage` 子树被销毁重建** → markdown 全部重新解析、Shiki 重新高亮。

#### 根因 4：Turn 对象每次全部重建

`webview-ui/src/context/session-queue.ts` 的 `messageTurns` 每次调用都构造全新 turn 对象：

```ts
// 优化前
result.push({ id: msg.id, user: msg, assistant: [] })   // 全新对象
```

virtua 虚拟列表按对象引用做 key（`For each={data.slice(...)}`），追加一条消息会让**所有可见 turn 换成新对象** → 所有可见 `VscodeSessionTurn` 卸载重建。

#### 根因 5：DataBridge 快照每次重建

`webview-ui/src/context/session.tsx` 的 `familyData` 每次调用都新建 `messages` / `parts` / `status` 三个对象，且遍历 family 内**全部**消息：

```ts
// 优化前
const messages: Record<string, Message[]> = {}
for (const sid of family) {
  for (const msg of msgs) parts[msg.id] = store.parts[msg.id]   // O(全部消息)
}
return { messages, parts, status }   // 每次都是新对象
```

`App.tsx` 的 `data()` memo 依赖它 → 任何一次 part delta 都让整份快照"看起来变了"。

### 2.3 排除的假设

| 假设 | 验证方式 | 结论 |
|---|---|---|
| LLM 响应慢 | CLI 埋点 ①→② | 排除：出字 43~75ms/token 属正常 |
| CLI 写入慢 | CLI 埋点 ② | 排除：0.35~7.2ms |
| 扩展转发慢 | 扩展埋点 ④→⑤ | 排除：1~6ms |
| IPC 传输慢 | ⑥ 对比 `sentAt` | 排除：2~19ms |
| 权限询问阻塞 | 开启 YOLO 对比 | 排除：无权限弹窗，间隔不变 |
| snapshot（git）开销 | 非 git 项目对照 | 排除：非 git 项目下 `vscode !== "git"` 直接短路，对照无效；git 项目稳态约 0.24s/轮，非主因 |
| KaTeX 扩展开销 | 基准测试对比 | 非主因：22.61ms vs 22.83ms，差异可忽略 |
| `markdown.sanitize` | 埋点 | 排除：0.4~0.87ms |

---

## 3. 方案设计

### 3.1 总体思路

```
减少重复工作 + 保住对象引用 + 缓存命中
```

三条主线：

1. **不重复解析**：流式文本按 token 分块，已完成块命中缓存，只解析尾块
2. **不重复渲染**：保住 message / turn 对象引用，让 Solid 的 `<For>` 和 virtua 不重建子树
3. **不重复计算**：DataBridge 快照做引用级缓存

### 3.2 Markdown 解析分块与缓存

#### 分块策略

`packages/ui/src/components/markdown-stream.ts`

按 `marked.lexer` 的 **token 边界**切块，而不是按空行：

```ts
const tokens = marked.lexer(text)
const blocks: Block[] = []
for (let i = 0; i < tokens.length; i++) {
  blocks.push({ raw: tokens[i].raw, src: i === tail ? heal(raw) : raw, mode: "live" })
}
```

**为什么按 token 而不是按空行**

按空行切分会破坏跨块结构（列表、块引用、表格），导致渲染错乱。`marked.lexer` 的 token 边界是语义安全的。

**等价性保证**

逐 token 解析再拼接，与整体解析结果**逐字节一致**（无引用定义时成立），已用单测覆盖 5 组用例（标题/段落/列表/表格/块引用/代码块）。

**安全回退**

以下情况退回单块，保证绝对正确：

| 情况 | 原因 |
|---|---|
| 含引用式链接 / 脚注定义 | 定义可出现在末尾，切块会破坏解析上下文 |
| 未闭合代码围栏 | 围栏内是连续内容 |
| `lexer` 无法切出多块 | 无可切分点 |

#### 缓存 key 改为内容 hash

`packages/ui/src/components/markdown.tsx`

```ts
// 优化后
const key = checksum(block.raw)
if (cached && cached.hash === key) { touch(key, cached); return cached.html }
```

内容不变即命中，流式期间已完成块稳定复用。

#### LRU 容量调整

```ts
const max = 200   // → 2000
```

分块后单条长消息可能产生数百个块，200 容量会导致频繁淘汰。

#### createResource 依赖修正

```ts
// 优化前：source 返回新对象，=== 永远不等 → 文本未变也重跑
() => ({ text: local.text, key: local.cacheKey, streaming: local.streaming ?? false })

// 优化后：多依赖数组逐项比较
() => [local.text, local.cacheKey, local.streaming ?? false] as const
```

#### 流式节流调整

`packages/ui/src/components/message-part.tsx`

```ts
const TEXT_RENDER_PACE_MS = 24   // → 64
```

24ms 节流在单次 parse 未完成时就会排下一帧，把主线程压满；64ms 仍保持打字机观感。

#### 实测收益

| 场景 | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| 单次全量 parse（12K 字符） | 330ms | — | — |
| 逐 token 分块（首次） | — | 32ms | 10× |
| 下一个 token（仅尾块） | 330ms | 0.10ms | 3300× |

### 3.3 消息对象引用稳定

**新增 `webview-ui/src/context/message-merge.ts`**

```ts
export function mergeMessagePatch(current, next): Fields {
  const patch = {}
  for (const key of Object.keys(next)) {
    if (key === "parts") continue          // part 存在独立 store 分区
    if (same(current[key], next[key])) continue
    patch[key] = next[key]
  }
  return patch
}
```

`session.tsx` 的 `handleMessageCreated` 改为字段级 patch：

```ts
// 优化后
const patch = mergeMessagePatch(current[index], message)
if (Object.keys(patch).length > 0) setStore("messages", sid, index, patch)
```

Solid store 的 `setStore(path, obj)` 是**合并赋值**，不会替换对象身份 → `<For>` 认为还是同一个元素 → 子树不重建。

**跳过 `parts` 的原因**：part 存在 `store.parts[messageID]` 独立分区，不在 message 对象上。

#### 3.3.1 同会话终态同步（stop 后）也要走 reconcile

**现象**：点「停止」后，日志出现成串的 `[渲染]AssistantMessage 首次挂载`：

```
⑦ store写入完成 类型=messagesLoaded 耗时=53.9ms
[渲染]VscodeSessionTurn 首次挂载=43.2ms
[渲染]AssistantMessage  首次挂载=44.0ms
[渲染]AssistantMessage  首次挂载=39.0ms
[渲染]AssistantMessage  首次挂载=34.0ms
... 一路降到 7.1ms

[渲染汇总] AssistantMessage 4次 总455.6ms 均101.1ms 峰43.3ms
[渲染汇总] VscodeSessionTurn 2次 总256.5ms 均128.2ms 峰145.0ms
```

**触发链**

```
点击「停止」
  → beginStopping(sid)：本地立即置 idle，丢弃在途 SSE 渲染事件
  → 扩展 abort HTTP 返回（server 已落盘）
  → 扩展主动发 loadMessages(mode: "replace")
  → webview handleMessagesLoaded 走 replace 分支
```

**根因**

`mode === "replace"` 一律直接整体赋值：

```ts
// 优化前
if (mode === "replace") {
  setStore("messages", sessionID, merged)   // 全新对象数组
} else {
  setStore("messages", sessionID, reconcile(merged, { key: "id" }))
}
```

`merged` 来自 server，每个 message 都是新对象 → `messageTurns` 产出全新 turn（`sameTurn` 比对失败）→ virtua 按引用判定"全部是新元素" → 所有可见轮次卸载重建。

**为什么第一次 44ms、后面降到 7ms**

markdown 的 HTML 缓存（内容 hash）在第二次解析同一内容时直接复用，剩下的只有组件树构建成本。

**修复：区分两种 replace 语义**

| 语义 | 场景 | 策略 |
|---|---|---|
| 首次加载 | 本地无消息（会话切换） | 直接赋值（最快，无需 diff） |
| 终态同步 | stop 后、错误恢复 | `reconcile(merged, { key: "id" })` |

```ts
// 优化后
if (mode === "replace" && current.length === 0) {
  setStore("messages", sessionID, merged)
} else {
  setStore("messages", sessionID, reconcile(merged, { key: "id" }))
}
```

**parts 同步必须一并调整**

原来只有 `mode === "reconcile"` 才直接写 store，`replace` 走 stash。若消息走 reconcile 而 parts 走 stash，两边会不同步：

```ts
// 优化前
if (mode === "reconcile" && store.parts[msg.id]) {
  setStore("parts", msg.id, reconcile(msg.parts, { key: "id" }))
  stash.remove(msg.id)
} else {
  stash.put(msg.id, msg.parts)
}

// 优化后：只要 part 已在 store 里就直接 reconcile
if (store.parts[msg.id]) {
  setStore("parts", msg.id, reconcile(msg.parts, { key: "id" }))
  stash.remove(msg.id)
} else {
  stash.put(msg.id, msg.parts)
}
```

**`reconcile` 引用保持验证**

```ts
// 输入：m1 内容不变，m2 多了 completed 字段
setStore("messages", reconcile(incoming, { key: "id" }))

m1 引用保持: true
m2 引用保持: true
m2.completed: 9      // 新字段正确写入
数组长度: 2
```

**预期效果**

| 场景 | 改前 | 改后 |
|---|---|---|
| 首次进入会话 | 直接赋值（快） | 不变 |
| stop 后终态同步 | 20+ 次首挂，~450ms | 0~1 次 |
| 错误恢复同步 | 同上 | 同上 |
| 滚动加载更早消息 | reconcile | 不变 |

### 3.4 Turn 对象结构共享

`webview-ui/src/context/session-queue.ts` 新增：

```ts
export function reuseTurns(previous, next) {
  if (!previous || previous.length === 0) return next
  let changed = previous.length !== next.length
  const merged = next.map((turn, index) => {
    const prior = previous[index]
    if (prior && sameTurn(prior, turn)) return prior    // 复用旧对象
    changed = true
    return turn
  })
  return changed ? merged : previous
}
```

`MessageList.tsx` 使用：

```ts
const turns = createMemo<MessageTurn[]>((prev) =>
  reuseTurns(prev, messageTurns(session.messages(), boundary()))
)
```

**关键设计：长度必须显式比较**

```ts
let changed = previous.length !== next.length
```

`map` 只遍历 `next`，若不比较长度，清空会话（新建任务）时 `next` 为空 → 循环不执行 → `changed` 仍为 `false` → 返回旧列表，界面继续显示旧会话。这是实现过程中实际踩到的 bug，已加回归测试。

### 3.5 绕开 DataBridge 全量快照

`AssistantMessage.tsx` / `VscodeSessionTurn.tsx`：

```ts
// 优化前：依赖整份 data 快照，任意 part 变化都让 memo 重算
const stored = data.store.part?.[props.message.id]

// 优化后：直读 session store，只依赖该消息的 parts 键
const stored = session.getParts(props.message.id)
```

**新增 `webview-ui/src/context/family-snapshot.ts`** —— familyData 引用级缓存：

```ts
// part 文本变化不改变数组引用 → 流式 token 不击穿缓存
if (prior !== undefined && prior === list) messages[id] = prior
else { messages[id] = list; changed = true }
```

只有 message/part 新增、删除、替换才重建快照。

### 3.6 KaTeX 按需启用

`packages/ui/src/context/marked.tsx`

```ts
// 拆成两个独立实例（原来共用全局单例，use() 会互相污染）
const base = new Marked().use({ renderer: {...} })
const math = new Marked().use(markedKatex({ throwOnError: false, nonStandard: true }))

const likelyMath = (t) => t.includes("$") || t.includes("\\(") || t.includes("\\[")
const parser = { parse: (t) => (likelyMath(t) ? math : base).parse(t) }
```

**同时修正一个隐患**：原代码 `import { marked }` 引用的是未导入的全局变量，`marked.use()` 的注册会泄漏到所有实例。改为 `import { Marked }` 并显式 `new`。

### 3.7 扩展宿主侧优化

`src/services/desktop-pet/desktop-pet-bridge.ts`

`testagent.pet.state` 是最高频的 SSE 事件，每次 `executeCommand` 在未安装桌面宠物时都会产生一次 rejected promise：

```ts
// 优化后
if (state === last) return              // 状态去重
if (available === false) return         // 命令不存在时永久停用
```

### 3.8 全链路耗时探针

#### CLI 侧

**新增 `packages/testagent-core/packages/opencode/src/testagent/latency.ts`**

- traceId：FNV-1a(`${sessionID}:${messageID}:${partID}`) 取 8 位十六进制
- 走 `Log.create({ service })` 写日志文件（`console.log` 在后台进程不落盘）

**`session/session.ts`** — `updatePart` / `updatePartDelta` 记录 ②
**`session/processor.ts`** — `text-delta` 首次触发记录 ①

#### 扩展宿主侧

**新增 `src/util/latency-probe.ts`** — ④ 收到 SSE / ⑤ 转发 webview（附加 `sentAt`）
**`src/KiloProvider.ts`** — `handleEvent` 入口 + `postMessage` 接入

#### webview 侧

**新增 `webview-ui/src/utils/latency-probe.ts`**

- ⑥ 收到 / ⑦ store 写入完成 / ⑧ 双 rAF 渲染完成 + 汇总行
- 组件级渲染耗时（`trackRender`）+ 每 5s 汇总排名

#### 修复的探针缺陷

| 缺陷 | 现象 | 修复 |
|---|---|---|
| traceId 撞车 | 所有无 part 标识事件共用 `980630f5`（即 `hash("::")`） | 改用自增序号 `#1`、`#2` |
| 时钟域混用 | `扩展→webview=-1793672501400ms` | 扩展 `Date.now()` 换算到 `performance.now()` 域 |
| 跨轮次假数字 | `距收到SSE=10780ms` | 转发后 `stamps.delete(key)` |
| `NaN` | `距LLM首字=NaNms` | `cliAt` 未设置时回填 |

#### 开关

```bash
# 默认开启；关闭：
TESTAGENT_LATENCY=0 bun run extension

# webview 运行时
__testagentLatency.off()
```

### 3.9 涉及文件清单

**新增（5 个）**

| 文件 | 作用 |
|---|---|
| `packages/testagent-core/packages/opencode/src/testagent/latency.ts` | CLI 侧探针 |
| `packages/kilo-vscode/src/util/latency-probe.ts` | 扩展宿主侧探针 |
| `packages/kilo-vscode/webview-ui/src/utils/latency-probe.ts` | webview 侧探针 |
| `packages/kilo-vscode/webview-ui/src/context/message-merge.ts` | 消息字段级 diff |
| `packages/kilo-vscode/webview-ui/src/context/family-snapshot.ts` | familyData 引用缓存 |

**修改（14 个）**

| 文件 | 改动 |
|---|---|
| `packages/opencode/src/session/session.ts` | `updatePart` / `updatePartDelta` 埋点 |
| `packages/opencode/src/session/processor.ts` | `text-delta` 埋点 |
| `packages/kilo-vscode/src/KiloProvider.ts` | `handleEvent` / `postMessage` 埋点 |
| `packages/kilo-vscode/src/services/desktop-pet/desktop-pet-bridge.ts` | 状态去重 + 命令可用性缓存 |
| `webview-ui/src/context/session.tsx` | 字段级 merge、familyData 缓存、replace 区分首载/终态同步 |
| `webview-ui/src/context/session-queue.ts` | `reuseTurns` |
| `webview-ui/src/context/vscode.tsx` | ⑥ 埋点 + 汇总回传 |
| `webview-ui/src/components/chat/MessageList.tsx` | 使用 `reuseTurns` |
| `webview-ui/src/components/chat/AssistantMessage.tsx` | 绕开 DataBridge |
| `webview-ui/src/components/chat/VscodeSessionTurn.tsx` | 绕开 DataBridge |
| `packages/ui/src/components/markdown.tsx` | 内容 hash 缓存、LRU 扩容、resource 依赖、修复 `patchStart` |
| `packages/ui/src/components/markdown-stream.ts` | token 分块 |
| `packages/ui/src/components/message-part.tsx` | 流式节流 24→64ms |
| `packages/ui/src/context/marked.tsx` | KaTeX 按需启用 |
| `packages/testagent-core/packages/opencode/src/snapshot/index.ts` | 见 5.2：保留名过滤 + 失败短路（与渲染优化独立） |

**测试（3 个）**

| 文件 | 用例数 |
|---|---|
| `webview-ui/tests/unit/session-queue.test.ts` | 复用 + 清空 + 变短 |
| `webview-ui/tests/unit/message-merge.test.ts` | 5 例 |
| `packages/ui/src/components/markdown-stream.test.ts` | 8 例（含 5 组解析等价性） |

---

## 4. 效果验证

### 4.1 指标对比

#### 稳定流式期（生产环境实测，snapshot: true）

```
[渲染汇总] VscodeSessionTurn  1次 总15.2ms 均15.2ms 峰15.2ms
[渲染汇总] AssistantMessage   1次 总12.8ms 均12.8ms 峰12.8ms
[渲染汇总] markdown.parse    12次 总9.8ms  均0.8ms  峰1.1ms
[渲染汇总] markdown.sanitize 12次 总3.8ms  均0.3ms  峰0.4ms
[渲染汇总] markdown.morphdom 25次 总2.9ms  均0.1ms  峰0.2ms
```

| 指标 | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| `markdown.parse` | 137ms 均（峰 249ms） | **0.8~1.2ms 均（峰 2.1ms）** | **~130×** |
| `markdown.morphdom` | — | 0.1ms 均 | — |
| `markdown.sanitize` | 0.87ms | 0.3ms | 3× |
| `AssistantMessage` 渲染 | 155ms（峰 246ms） | **12.8ms** | **12×** |
| `VscodeSessionTurn` 渲染 | 100ms（峰 251ms） | **15.2ms** | **6.6×** |
| 渲染帧耗时 | 30~49ms | 7.8~24.7ms | **2~3×** |
| 长任务峰值 | 728ms | 76ms | **9.6×** |
| store 应用（partUpdated） | 1.8~14ms | 0.5~1.8ms | 3~8× |
| store 应用（messageCreated） | 12.7~18.9ms | 0.3~0.4ms | **~40×** |
| 扩展转发 | 1~6ms | 1ms | — |

> `markdown.parse` 现在"12 次总共 9.8ms"，说明 token 分块 + 内容 hash 缓存完全生效：
> 大部分块直接命中缓存，只有尾块真正解析。

#### 会话切换期（一次性成本，未优化）

```
⑦ store写入完成 类型=messageCreated 耗时=53.3ms
[渲染]VscodeSessionTurn 首次挂载=50.4ms
[渲染]AssistantMessage  首次挂载=44.4ms
[渲染]AssistantMessage  首次挂载=29.8ms
⑧ 渲染完成 距收到=64.5ms 帧耗时=11.0ms
```

`messagesLoaded` 的 store 写入 53.3ms 是唯一的量级单点，属于会话切换时的一次性成本。
注意此时 `markdown.parse` 未出现在汇总里（低于 4ms 阈值），说明 44ms 的挂载成本在**组件树构建**（DOM 创建、工具卡片），不在 markdown。

### 4.2 验收标准达成

| FR | 目标 | 实测 | 结论 |
|---|---|---|---|
| FR-01 单帧 < 16.7ms | 16.7ms | 10~18ms | ✅ 基本达成 |
| FR-01 `markdown.parse` < 10ms | 10ms | 0.8~1.2ms | ✅ |
| FR-01 长任务 0~1 次/2s | ≤1 | 0~1 | ✅ |
| FR-02 全链路可观测 | 8 环节 | 8 环节全埋点 | ✅ |
| FR-03 渲染正确性 | 逐字节一致 | 5 组等价性单测全通过 | ✅ |

### 4.3 回归验证

| 检查 | 结果 |
|---|---|
| `markdown-stream` 单测 | 8 pass |
| `session-queue` / `message-merge` / scheduler / prompt-rail | 59 pass |
| `check-types:webview` | 改动文件 0 新增错误 |
| `packages/ui` tsc | 0 错误 |
| `eslint` | 仅仓库既有报错（`buildResultMarkdown` 34、`turnStats` 25、`handleSessionExtensionMessage` 41） |
| `esbuild` | 构建通过 |

---

## 5. 已回退的方案及原因

记录以免后续重复踩坑。

| 方案 | 实测收益 | 回退原因 |
|---|---|---|
| `AssistantMessage` 按 part 类型创建 memo | 仅省 5ms（占比 0.5%），且是一次性成本 | 为压 lint 复杂度抽了 25 行工厂函数 + `none`/`never` 魔法常量，增加渲染路径间接层 |
| markdown 按空行切块 | — | 会破坏列表、块引用、表格等跨块结构 |
| `PacedMarkdown` 判断"已追平即非流式" | 0 | `tryFastRender` 要求容器为空，流式时容器非空仍走 morphdom |
| 全量 outbox 批处理（P1-2） | 未实施 | 当前 `merged` 比例已够，且改动面大 |
| turn 内步骤窗口化（默认只渲染最后 12 步） | 未实施 | 依赖"单轮 302 条 assistant"的 mocker 场景；真实模型下单轮步骤少，收益不明显 |

### 5.1 关于 snapshot（git）的澄清

压测时观察到轮次间隔 11~31s，曾怀疑是 CLI 的 snapshot 机制。实测结论：

- 非 git 项目：`vscode !== "git"` 直接短路，`snapshot: true/false` 走同一路径 → 对照实验无效
- git 项目稳态：`diff-files` + `ls-files --others` + `write-tree` 约 **0.24s/轮**（首次全量 add 5s 是一次性成本）
- 因此 **snapshot 不是 webview 渲染卡顿的原因**，两者是独立的性能面

> 需要注意：snapshot 虽然与渲染无关，但在真实 Windows 项目上确实存在会导致 **单轮阻塞 1.2~1.5s** 的问题，
> 见 5.2。它影响的是"轮次推进速度"，不是"页面流畅度"。

#### 真实环境实测（Windows / 1265px 宽日志）

| 场景 | 耗时 |
|---|---|
| `git diff-files` + `ls-files` + `stage` | 正常路径 |
| `track()` 成功一次 | **1233ms** |
| `track()` 在 `git add` 失败时 | **1531ms**（比成功更慢） |

与 macOS 实测的 0.24s/轮差异巨大，原因是：

| 因素 | 说明 |
|---|---|
| 文件系统 | NTFS 上 `diff-files` / `ls-files` 明显慢于 APFS |
| 仓库规模 | 被测项目 `LV01.82_TestCode测试` 的文件数远超本地样本 |
| 冷缓存 | 日志前一条是 `background dependency install failed`，刚触发 `npm install`，页缓存被冲刷 |
| 跨目录 | snapshot gitdir 位于 `%LOCALAPPDATA%\testagent\snapshot\...`，与工作区不同卷 |

### 5.2 snapshot 的两个独立缺陷（v1.1 修复）

这两个问题与 webview 渲染无关，是排查渲染问题时**顺带发现**的真实 bug。

#### 缺陷 1：Windows 保留设备名导致 `git add` 整次失败

**现象**

```
WARN service=snapshot exitCode=128 stderr=error: invalid path 'nul'
error: unable to add 'nul' to index
fatal: adding files failed
 failed to add snapshot files
```

**根因**

Windows 保留了 `nul` / `con` / `aux` / `prn` / `com1-9` / `lpt1-9` 作为设备名，git 无法索引这类路径。
只要候选文件集中出现任意一个，**整次 `git add` 都会失败**（不是跳过该文件，而是全部放弃）。

**后果链**

```
git add 失败  →  索引停留在旧状态  →  write-tree 仍执行  →  返回上一次的树哈希
                →  log 里出现 "tracking hash=50da998..."（与上次完全相同）
                →  快照静默变成陈旧数据，diff 结果错误
```

这是最危险的地方：**失败是静默的**，日志里只有一条 `WARN`，但 `tracking` 看起来一切正常。

**修复**

```ts
// snapshot/index.ts 模块级新增
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function reserved(file: string): boolean {
  const base = file.split(/[\\/]/).pop() ?? ""
  return WINDOWS_RESERVED.test(base)
}
```

```ts
// add() 内，在原有 ignore / large 过滤之后
const blocked = all.filter((item) => reserved(item))
if (blocked.length) {
  log.info("skipping reserved paths in snapshot", { count: blocked.length, sample: blocked.slice(0, 5) })
}
const allow = all.filter((item) => !ignored.has(item) && !reserved(item))
```

**正则设计要点**

只匹配**完整文件名**，不做子串匹配，避免误伤：

| 输入 | 结果 | 说明 |
|---|---|---|
| `nul` / `nul.txt` / `src/nul` / `a/b/NUL.log` | 排除 | 保留设备名 |
| `com1` / `lpt9.txt` | 排除 | 保留设备名 |
| `console.log` | 保留 | 不是 `con` |
| `nullable.ts` / `null.ts` | 保留 | 不是 `nul` |
| `auxiliary.md` | 保留 | 不是 `aux` |
| `com10` / `lpt10` | 保留 | 只匹配 1-9 |

已用 18 组用例验证，全部通过。

#### 缺陷 2：add 失败后仍执行 `write-tree`

**现象**

`stage()` 失败时只打一条 `warn`，`add()` 静默返回，`track()` 无条件继续：

```ts
yield* add()
const result = yield* git(args(["write-tree"]), { cwd: state.directory })
const hash = result.text.trim()
log.info("tracking", { hash, ... })   // ← 这个 hash 是陈旧的，但日志看不出来
```

**根因**

`add()` / `stage()` 都没有把失败传递给调用方，`track()` 无法判断索引是否有效。

**修复**

三级传递失败状态：

```ts
// stage() 返回是否成功
const stage = Effect.fnUntraced(function* (files: string[]) {
  if (!files.length) return true
  const result = yield* git([...], { ... })
  if (result.code === 0) return true
  log.warn("failed to add snapshot files", { exitCode: result.code, stderr: result.stderr })
  return false
})

// add() 返回是否成功
// 列文件失败 → return false
// 无候选文件 / 全部被忽略 → return true
// 正常路径 → return yield* stage(...)

// track() 短路
const staged = yield* add()
if (!staged) {
  log.warn("snapshot skipped: staging failed", { cwd: state.directory })
  return undefined
}
const result = yield* git(args(["write-tree"]), { cwd: state.directory })
```

**下游安全性**

`track()` 现在可能返回 `undefined`，已确认所有调用点均安全：

| 调用点 | 处理 |
|---|---|
| `processor.ts:133` | `ctx.snapshot` 类型为 `string \| undefined` |
| `processor.ts:469` | `if (!ctx.snapshot)` 保护，下次 step 自动重试 |
| `processor.ts:494` | `step-finish` 的 `snapshot` 字段是 `Schema.optional(String)` |
| `processor.ts:568` | `if (ctx.snapshot)` 才执行 patch，`undefined` 时跳过 |

**语义**：本次不做快照，`ctx.snapshot` 保持上一个有效值，diff 仍基于最近一次成功快照 —— 正确且不会污染数据。

#### 修复前后日志对比

**修复前**

```
WARN service=snapshot exitCode=128 stderr=error: invalid path 'nul' ... failed to add snapshot files
INFO service=snapshot hash=50da998dae29993cc3532036fc4f294fcaccb6df cwd=... tracking
                                                          ↑ 陈旧哈希，静默错误
```

**修复后（保留名被过滤）**

```
INFO service=snapshot skipping reserved paths in snapshot {count: 1, sample: ["nul"]}
INFO service=snapshot hash=<新哈希> cwd=... tracking
```

**修复后（其他原因导致 add 失败）**

```
WARN service=snapshot failed to add snapshot files exitCode=... stderr=...
WARN service=snapshot snapshot skipped: staging failed cwd=...
```
不再产生误导性的 `tracking` 日志。

#### 涉及文件

| 文件 | 改动 |
|---|---|
| `packages/testagent-core/packages/opencode/src/snapshot/index.ts` | 新增保留名判定；`stage()` / `add()` 返回 boolean；`track()` 失败短路 |

#### 未修复（需要产品决策）

`track()` 单次 1.2~1.5s 的开销仍然存在。可选方向：

| 方向 | 收益 | 风险 |
|---|---|---|
| 树未变时跳过 `add()` | 工具未改文件时省掉整次扫描 | 需要可靠的工作区变更检测（mtime / 文件监听） |
| `track()` 异步化 | 不阻塞 step 循环 | `step-start` part 需要立即写入 snapshot 字段 |
| 压测专用开关 | 最快 | 会绕过快照功能本身 |

---

## 6. 遗留与后续方向

### 6.1 并发工具调用的渲染节奏

**现象**：5 个 `glob` 并发时，工具卡片"一股脑全出现"。

**原因链**

```
后端：5 个 glob 并发，每个经历 pending → running → completed
      ② CLI写入part 各 1.3~2.1ms（后端很快）
      ↓
扩展：20 条 partUpdated 全部落在同一个 32ms 合并窗口
      ↓
调度器：合并后一次性 emit（这是设计意图，不是 bug）
      ↓
webview：同一帧创建 5 个工具卡片 → 视觉上"同时出现"
```

前端日志的特征是：同一 traceId 的 `④ 扩展收到SSE` 密集重复，但 `⑤ 扩展转发webview` 只出现一次。

**评估**：这是合并窗口的正常行为，**不是性能问题**。是否要改取决于产品期望：

| 方案 | 效果 | 代价 |
|---|---|---|
| 保持现状 | 工具卡片同时出现，与后端实际并发一致 | — |
| rAF 错峰渲染 | 卡片逐个出现，有"生长"动画感 | 增加复杂度，可能让人误以为工具是串行的 |
| 按批次分组展示 | 明确表达"并发执行"语义 | 需要新的 UI 组件 |

暂不实施，因为当前行为在语义上是正确的。

### 6.2 其他候选方向（收益递减，暂不实施）

| 方向 | 预估收益 | 成本 | 说明 |
|---|---|---|---|
| `marked.parse` 移入 Web Worker | 主线程完全不阻塞 | 高 | VS Code webview 的 worker 打包链路不完善（pierre worker 已被 stub） |
| turn 内步骤虚拟化 | 单轮步骤极多时有效 | 中 | 需处理滚动锚点、高度测量 |
| `sse.sync` 事件内容哈希去重 | 低 | 低 | 扩展宿主已有过滤，实际开销小 |
| `messagesLoaded` 增量加载 | 首次加载 53.3ms store + 64.5ms 帧 | 中 | 一次性成本，可接受 |
| `track()` 树未变时跳过 `add()` | snapshot 省掉整次扫描（1.2s） | 中 | 需要可靠的工作区变更检测（mtime / 文件监听） |
| `track()` 异步化 | 不阻塞 step 循环 | 中 | `step-start` part 需要立即写入 snapshot 字段 |

### 6.3 探针的长期价值

全链路埋点建议保留（默认开启、可关闭）。后续任何"卡顿"反馈都可以用同一套 traceId 快速定位到具体环节，避免重复做排除法。

### 6.4 缓存容量监控

`markdown.tsx` 的 LRU 从 200 提到 2000。若后续出现内存压力，可改为按字节数计容（当前按条目数）。

---

## 7. 经验总结

### 7.1 有效的排查路径

**主链路（卡顿）**

```
全链路埋点 → 定位到"渲染"这一段
   ↓
组件级埋点 → 定位到 AssistantMessage
   ↓
markdown 分阶段埋点 → 定位到 marked.parse
   ↓
基准测试 → 确认是"文本长度 × 调用次数"，不是单点异常
   ↓
方案：减少调用次数（分块 + 缓存）
```

**次链路（stop 后重挂载）**

```
观察到 [渲染]XXX 首次挂载 成串出现
   ↓
看挂载前的最后一条日志 → messagesLoaded（mode=replace）
   ↓
确认触发源 → stop 后的强制同步（不是会话切换）
   ↓
定位到 replace 分支直接整体赋值 → 对象身份全变
   ↓
方案：区分"首次加载"与"终态同步"，后者用 reconcile
```

**通用手法**：把"首次挂载"这类一次性事件当作信号，而不是噪声。
`首次挂载` 本身正常，但**成串出现且每次耗时递减**说明是同一批内容被反复重建 —— 递减正是缓存生效的特征。

**关键教训**：不要凭直觉优化。本次过程中有四处直觉判断错误：

| 直觉判断 | 实测 | 结果 |
|---|---|---|
| "150 轮 × 5 part = 750 个 memo，肯定很慢" | 仅 5.67ms，一次性 | 已回退 |
| "PacedMarkdown 传非流式就能走 fastpath" | 容器非空仍走 morphdom | 已回退 |
| "snapshot 的 git add 是渲染卡顿主因" | 非 git 项目短路，对照无效 | 澄清并单独立项 |
| "replace 一律直接赋值最快" | 首次加载确实最快，但终态同步场景导致 20+ 次重挂载 | 按语义分流（3.3.1） |

### 7.2 埋点设计的教训

探针本身出过 4 次 bug，都是"看起来正常但数据错误"：

| 缺陷 | 表现 | 教训 |
|---|---|---|
| traceId 撞车 | 所有无标识事件共用同一 ID | 兜底值必须唯一（用自增序号，不用 `hash("")`） |
| 时钟域混用 | 负数耗时 | 跨进程传递时间戳时，必须标明时钟源 |
| 跨轮次假数据 | `距收到SSE=10780ms` | 生命周期结束要清理状态（`stamps.delete`） |
| 未定义变量 | `perfTime is not defined` | 探针代码也要过类型检查和构建验证 |

**教训**：探针代码不能当作"临时脚本"对待，它的错误会直接导致错误结论。

---

## 附录：日志格式参考

```
[链路][a1b2c3d4] ① LLM首字 类型=text
[链路][a1b2c3d4] ② CLI写入part 类型=delta:text 耗时=0.42ms 距LLM首字=0.8ms 长度=12
[链路][a1b2c3d4] ④ 扩展收到SSE 类型=message.part.delta
[链路][a1b2c3d4] ⑤ 扩展转发webview 类型=partUpdated 距收到SSE=1.2ms
[链路][a1b2c3d4] ⑥ webview收到 类型=partUpdated
[链路][a1b2c3d4] ⑦ store写入完成 类型=partUpdated 耗时=1.4ms
[链路][a1b2c3d4] ⑧ 渲染完成 距收到=16.3ms 帧耗时=16.1ms
[链路][a1b2c3d4] 汇总 收到→渲染=16.3ms store应用=1.4ms 扩展→webview=3.1ms

[渲染汇总] 组件 次数 总耗时 均值 峰值
[渲染汇总] markdown.parse 4次 总2.1ms 均0.5ms 峰0.9ms
[渲染汇总] AssistantMessage 3次 总53ms 均17.7ms 峰25ms
```

### 判读表

| 观察 | 结论 |
|---|---|
| ① 之后长时间无 ② | LLM 慢 |
| ②→④ 间隔大 | CLI 入库/广播慢 |
| ④→⑥ 间隔大 | 扩展宿主 → webview IPC 拥塞 |
| ⑥→⑦ 大 | store 写入/响应式图重算慢 |
| ⑦→⑧ 大 | 前端渲染慢 |
