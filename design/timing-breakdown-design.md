# 会话耗时多维度拆分 — 需求与方案设计

> 版本：v2.1  
> 日期：2026-07-31  
> 状态：已实现  
> 修订：v2.1 按实际实现对齐 —— tool 精确计算、`tick` 信号、上报位置改为 run-state.ts、tooltip/展示细节、Metric 属性、文件清单补充 run-state.ts

---

## 目录

1. [需求设计](#1-需求设计)
   - [1.1 业务背景](#11-业务背景)
   - [1.2 用户故事](#12-用户故事)
   - [1.3 功能需求](#13-功能需求)
   - [1.4 非功能需求](#14-非功能需求)
2. [方案设计](#2-方案设计)
   - [2.1 总体架构](#21-总体架构)
   - [2.2 数据模型设计](#22-数据模型设计)
   - [2.3 后端实现](#23-后端实现)
   - [2.4 前端实现](#24-前端实现)
   - [2.5 遥测埋点](#25-遥测埋点)
   - [2.6 涉及文件清单](#26-涉及文件清单)
   - [2.7 变更影响范围](#27-变更影响范围)

---

## 1. 需求设计

### 1.1 业务背景

当前项目已有会话总耗时展示（WorkingIndicator 实时计时），但缺乏细粒度的时间拆分。用户无法区分：

- **总耗时**中哪些是 AI 实际工作的时间
- **哪些是等待用户确认/回复的时间**
- **每次 LLM 调用花了多久**

这些信息对排查性能瓶颈、优化 prompt、评估模型效率至关重要。

### 1.2 用户故事

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| US-01 | 作为开发者，我希望看到一次任务的**总耗时**，以了解整体运行效率 | P0 |
| US-02 | 作为开发者，我希望看到**LLM 总耗时**（所有 LLM 调用的累加），以评估模型响应速度 | P0 |
| US-03 | 作为开发者，我希望看到**实际执行耗时**（剔除等待用户输入的时间），以评估 AI 自主工作的效率 | P1 |
| US-04 | 作为开发者，我希望在 TaskHeader 中**悬浮看到耗时明细 + 百分比**，无需切换到新页面 | P1 |
| US-05 | 作为技术运营，我希望耗时数据通过 **ELK 可收集**，用于批量分析和监控 | P1 |

### 1.3 功能需求

#### FR-01：耗时维度定义

| 维度 | 定义 | 计算公式 |
|-----|------|---------|
| **总耗时** `total_duration` | 墙上时钟与累加和的最大值，保证数据自洽 | `max(wallClock, llm + tool + wait)` |
| **LLM 总耗时** `llm_duration` | 所有 LLM stream 调用耗时的累加和（跨家族会话累加） | `Σ(assistant.time.llm)` |
| **等待耗时** `wait_duration` | 因询问用户（question 工具）、无效参数（invalid）等需要用户交互而等待的时间。已完成工具取 `end - start`，运行中工具取 `Date.now() - start` 实时估算 | `Σ(completedTool.end - start) + Σ(runningTool.now() - start)` |
| **实际耗时** `actual_duration` | AI 自主工作的时间（总耗时 - 等待耗时） | `total_duration - wait_duration` |
| **工具执行耗时** `tool_duration` | 各工具实际执行时间的总和 | `Σ(toolPart.end - toolPart.start)` |

#### FR-02：前端展示

**展示位置 A — TaskHeader token 行下方**

```
任务累计耗时 | LLM: 27.2s | 工具执行: 4.1s | 等待用户: 3.0s | 总计: 37.3s

                        ↓ 悬浮「总计」37.3s
 ┌─────────────────────────────────────────────────────────┐
 │  总耗时:       37.3s                                     │
 │  ─────────────────                                        │
 │  ● LLM 耗时:   27.2s (72.9%)                              │
 │  ● 工具执行:    4.1s (11.0%)                              │
 │  ● 等待用户:    3.0s (8.0%)                               │
 │  ● 实际执行:   34.3s (92.0%)                              │
 │  ● 其他开销:    3.0s (8.1%)                               │
 └─────────────────────────────────────────────────────────┘
```

> 说明：LLM / 工具执行 / 等待用户是跨家族会话的**累加值**（子会话与父会话时间可重叠），
> 因此百分比相加可能超过 100%。inline 行只展示时长不展示百分比，避免混淆；
> 「其他开销」仅在 `total > llm + tool + wait` 时出现，「等待用户」仅在 `wait > 0` 时出现。

**展示位置 B — 时间线旁边的时间轴**（可选）

在 `TaskTimeline` 旁边新增耗时分段条，颜色编码与响应类型一致。

#### FR-03：耗时条可视化

- 总耗时显示为一条完整的色条（如上图）
- 内部按照 LLM / 等待 / 工具执行等维度分段，不同颜色
- 悬浮时显示明细和百分比
- 与 context breakdown 条视觉风格一致

#### FR-04：数据持久化与遥测

- 每条 assistant 消息记录 `time.llm`（LLM 调用耗时）
- 每条 tool part 已有 `time.start` / `time.end`
- 会话结束时通过 `effect.Metric.gauge` 上报到 OTLP 端点
- 在 ELK 中可查询 `session.duration.*` 系列指标

### 1.4 非功能需求

| 编号 | 要求 | 说明 |
|------|------|------|
| NFR-01 | 向后兼容 | 旧会话数据 `time.llm` 字段可能缺失，前端需做空值处理 |
| NFR-02 | 数据准确性 | 耗时统计应考虑子会话（subagent）的耗时，支持按 session family 聚合 |
| NFR-03 | 前端性能 | 耗时计算为纯函数，在 `session-utils.ts` 中计算，不引入额外订阅 |
| NFR-04 | 遥测开销 | gauge 指标为 DELTA 聚合，每次会话结束上报一次，量级很小 |

---

## 2. 方案设计

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 前端 (VS Code Extension Webview)                            │
│                                                             │
│  TaskHeader.tsx                  session-utils.ts           │
│  ┌───────────────────┐          ┌──────────────────┐       │
│  │ 耗时展示行         │ ──────→ │ buildFamilyTiming│       │
│  │ tooltip 明细       │          │ (纯函数)          │       │
│  │ 耗时百分比条       │          └──────────────────┘       │
│  └───────────────────┘                                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ 通过 ExtensionMessage 获取消息数据
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 后端 (testagent-core / effect 运行时)                        │
│                                                             │
│  processor.ts                  message-v2.ts                │
│  ┌───────────────────┐        ┌──────────────────┐         │
│  │ LLM stream 计时    │ ────→ │ Assistant.time.llm│         │
│  │ Metric.update()    │        └──────────────────┘         │
│  └───────────────────┘                                      │
│                                                             │
│  observability.ts              core/src/effect/             │
│  ┌───────────────────┐        ┌──────────────────┐         │
│  │ session.duration.* │ ────→ │ OTLP Exporter     │ ───→ ELK│
│  │ gauge 定义         │        │ /v1/metrics       │         │
│  └───────────────────┘        └──────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据模型设计

#### 2.2.1 Assistant 消息 — 新增 `time.llm` 字段

**文件**: `packages/opencode/src/session/message-v2.ts`

当前 Schema（第 540-543 行）：
```typescript
time: Schema.Struct({
  created: NonNegativeInt,
  completed: Schema.optional(NonNegativeInt),
})
```

修改后：
```typescript
time: Schema.Struct({
  created: NonNegativeInt,
  completed: Schema.optional(NonNegativeInt),
  // testagent_change start
  llm: Schema.optional(NonNegativeInt),  // LLM stream 总耗时 (ms)
  // testagent_change end
}),
```

#### 2.2.2 前端数据结构

**文件**: `packages/kilo-vscode/webview-ui/src/context/session-utils.ts`

新增 `TimingInfo` 类型：
```typescript
export interface TimingInfo {
  total: number        // 总耗时 (ms)
  llm: number          // LLM 总耗时 (ms)
  wait: number         // 等待用户耗时 (ms)
  actual: number       // 实际执行耗时 (ms)
  tool: number         // 工具执行耗时 (ms)
}

export interface TimingSegment {
  key: string          // "llm" | "tool" | "wait" | "overhead"
  label: string        // 展示文案
  duration: number     // 毫秒值
  percent: number      // 百分比 (0-100)
  width: number        // 宽度百分比
  color: string        // 颜色值
}
```

> 实现说明：`TimingSegment.key` 实际取值固定为 `llm / tool / wait / overhead` 四种，
> 不包含 `actual`（实际执行仅出现在 tooltip 明细中，不作为分段条展示）。

### 2.3 后端实现

#### 2.3.1 记录 LLM 耗时

**文件**: `packages/opencode/src/session/processor.ts`

在 stream 完成处（第 788-805 行）新增写入：

```typescript
// testagent_change start
const totalElapsed = Date.now() - streamStartTime
// 将 LLM 耗时记录到 assistant message
ctx.assistantMessage.time.llm = totalElapsed
yield* sessions.updateMessage(ctx.assistantMessage)
// testagent_change end
```

#### 2.3.2 新增遥测 Metric 定义

**文件**: `packages/core/src/effect/observability.ts`

新增 gauge 指标：

```typescript
// testagent_change start
export const sessionTotalDuration = Metric.gauge("session.duration.total", {
  description: "Session total duration including user wait (ms)",
})
export const sessionLlmDuration = Metric.gauge("session.duration.llm", {
  description: "Sum of all LLM call durations (ms)",
})
export const sessionWaitDuration = Metric.gauge("session.duration.wait", {
  description: "Time spent waiting for user input (ms)",
})
export const sessionActualDuration = Metric.gauge("session.duration.actual", {
  description: "Session duration excluding user wait (ms)",
})
// testagent_change end
```

#### 2.3.3 在会话结束时上报耗时

**位置（实现）**: `packages/opencode/src/session/run-state.ts` — `onIdle` 回调中上报（而非初稿设想的 prompt.ts / processor.ts）

```typescript
// testagent_change start - report session duration metrics
const start = data.busyStart.get(sessionID)
if (start) {
  data.busyStart.delete(sessionID)
  const elapsed = Date.now() - start
  yield* Metric.update(
    Metric.withAttributes(sessionTotalDuration, { sessionID }),
    elapsed,
  )
  // compute wait time from session messages (safe: catch if db not ready)
  let waitTime = 0
  try {
    const msgs = MessageV2.page({ sessionID, limit: 500 })
    for (const m of msgs.items) {
      if (m.info.role !== "assistant") continue
      for (const p of m.parts) {
        if (p.type === "tool" && (p.tool === "question" || p.tool === "invalid")) {
          if (p.state.status === "completed" && "time" in p.state && p.state.time?.start && p.state.time?.end) {
            waitTime += p.state.time.end - p.state.time.start
          }
        }
      }
    }
  } catch {
    // db not ready or no messages — waitTime stays 0
  }
  const actualTime = Math.max(0, elapsed - waitTime)
  yield* Metric.update(Metric.withAttributes(sessionWaitDuration, { sessionID }), waitTime)
  yield* Metric.update(Metric.withAttributes(sessionActualDuration, { sessionID }), actualTime)
}
// testagent_change end
```

> 实现说明：
> - `session.duration.llm` 不在会话结束时统一上报，而是在 processor.ts 每次 LLM stream 完成后随 `time.llm` 一起上报（见 2.3.1），并携带 `modelID` / `providerID` 属性。
> - `session.duration.total / wait / actual` 在 `onIdle` 上报，属性仅 `sessionID`。

### 2.4 前端实现

#### 2.4.1 纯函数：计算耗时

**文件**: `packages/kilo-vscode/webview-ui/src/context/session-utils.ts`

新增 `buildFamilyTiming()` 函数（模式与 `buildFamilyTokens()` 完全相同）：

```typescript
/** 需要等待用户响应的工具列表 */
const WAIT_TOOLS = new Set(["question", "invalid"])

/** 需要请求用户审批的工具类型 */
// 在 prompt.ts 中，ToolStateRunning 的 tool 通过 ctx.ask() 等待审批

/**
 * 计算会话族的总耗时、LLM耗时、等待耗时、工具执行耗时、实际耗时
 */
export function buildFamilyTiming(
  family: Set<string>,
  messages: Record<string, TimingMessage[]>,
  parts: Record<string, TimingTaskPart[]>,
): TimingInfo | undefined {
  let total = 0
  let llm = 0
  let wait = 0
  let tool = 0
  let has = false

  for (const sid of family) {
    const msgs = messages[sid] ?? []
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
          } else {
            tool += dur // 其他正常工具算工具执行
          }
        }
      }
    }
    // 找第一条和最后一条消息的时间确定总耗时
    const first = msgs[0]
    const last = msgs[msgs.length - 1]
    if (first?.role === "user" && first.time?.created && last?.role === "assistant" && last.time?.completed) {
      total = Math.max(total, last.time.completed - first.time.created)
    }
  }

  if (!has) return undefined

  // 总计取累加和与墙上时钟的最大值，保证数据自洽
  // 子会话与父会话时间重叠时，累加和 > 墙上时钟
  const accumulated = llm + tool + wait
  const finalTotal = Math.max(total, accumulated)

  const actual = Math.max(0, finalTotal - wait)

  return { total: finalTotal, llm, wait, actual, tool }
}
```

> 实现说明：
> - 与初稿相比，`tool` 已精确计算（`end - start`，运行中工具用 `Date.now() - start` 实时估算），不再是占位的 `tool: 0`。
> - 总耗时取「墙上时钟（末条 assistant.completed - 首条 user.created）」与「累加和（llm + tool + wait）」的**最大值**，保证子会话时间重叠时数据自洽。
> - 无任何 assistant 消息时返回 `undefined`（`has` 标志），避免空会话显示 0。其余维度（`buildTimingSegments`、`fmtDuration`）同实现，分段条固定四段：`llm / tool / wait / overhead`。

#### 2.4.2 前端耗时展示组件

**文件**: `packages/kilo-vscode/webview-ui/src/context/session.tsx`

在 context 中新增 `familyTiming`：

```typescript
// 新增 interface 字段
familyTiming: Accessor<TimingInfo | undefined>

// tick 信号保证活跃会话每秒重算，使 buildFamilyTiming 内的 Date.now() 刷新
const [tick, setTick] = createSignal(Date.now())
createEffect(() => {
  if (!anyBusy()) return // 无活跃会话时不 tick
  const id = setInterval(() => setTick(Date.now()), 1000)
  onCleanup(() => clearInterval(id))
})

// 实现
const familyTiming = createMemo<TimingInfo | undefined>(() => {
  const id = currentSessionID()
  if (!id) return undefined
  tick() // 依赖 tick，活跃时每秒重算
  return buildFamilyTiming(sessionFamily(id), store.messages as any, store.parts as any)
})

// 导出
export const useSession = () => {
  return {
    // ... 已有字段
    familyTiming,
  }
}
```

> 实现说明：与初稿相比，`familyTiming` 内部增加了 `tick` 信号 —— 仅在 `anyBusy()` 时每秒触发重算，
> 让 `buildFamilyTiming` 内运行中工具的 `Date.now() - time.start` 实时估算能持续刷新；无活跃会话时不空转。

#### 2.4.3 TaskHeader 修改

**文件**: `packages/kilo-vscode/webview-ui/src/components/chat/TaskHeader.tsx`

**关键逻辑**:

1. **实时计时器**：`setInterval` 每秒 tick（无条件运行）
2. **liveTiming memo**：不依赖 session busy 状态，直接从消息时间线和运行中工具估算
3. **空闲检测**：会话 idle 时回退到静态 `t.total`，避免停止后继续计时
4. **总计一致性**：`total = max(wallClock, llm + tool + wait)`，保证子会话重叠时数据自洽

```tsx
// 实时计时器：只要存在消息就每秒 tick，保证耗时持续变动
const [now, setNow] = createSignal(Date.now())
createEffect(() => {
  const id = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(id))
})

// 实时耗时：由 buildFamilyTiming 遍历 family 估算（含子会话的运行中工具）
// 仅活跃会话时用 Date.now() 实时计算，空闲时回退到静态数据
const liveTiming = createMemo(() => {
  const t = timing()
  const msgs = session.messages()
  const isIdle = session.status() === "idle"
  if (msgs.length === 0 && !t) return undefined
  if (isIdle && t) return t  // 空闲时回退静态数据

  // 找第一条用户消息的时间作为 session 起点
  let sessionStart: number | undefined
  for (const m of msgs) {
    if (m.role === "user" && m.time?.created) {
      sessionStart = m.time.created
      break
    }
  }

  // 总计取累加和与墙上时钟的最大值，与 buildFamilyTiming 保持一致
  const since = session.busySince()
  const wallClock = since
    ? Date.now() - since
    : sessionStart
      ? Date.now() - sessionStart
      : (t?.total ?? 0)
  const accumulated = (t?.llm ?? 0) + (t?.tool ?? 0) + (t?.wait ?? 0)
  const total = Math.max(wallClock, accumulated, t?.total ?? 0)

  return {
    total,
    llm: t?.llm ?? 0,
    wait: t?.wait ?? 0,
    actual: Math.max(total - (t?.wait ?? 0), 0),
    tool: t?.tool ?? 0,
  }
})

// 展示（实际实现：inline 展示行，无独立色条）
<Show when={liveTiming()}>
  {(t) => {
    const segments = () => buildTimingSegments(t())
    const pct = (v: number) => t().total > 0 ? `(${((v / t().total) * 100).toFixed(1)}%)` : ""
    return (
      <div class="task-header-tokens" style={{ "margin-top": "6px", "line-height": "1.4" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-wrap": "wrap" }}>
          <span class="task-header-tokens-label" style={{ "margin-right": "10px" }}>任务累计耗时</span>
          <For each={segments()}>
            {(seg, index) => (
              <>
                {index() !== 0 && <span style={{ opacity: 0.4 }}>|</span>}
                <span style={{ color: seg.color, "font-size": "11px" }}>
                  {seg.label}: {fmtDuration(seg.duration)}
                </span>
              </>
            )}
          </For>
          <span style={{ opacity: 0.4 }}>|</span>
          <Tooltip value={明细 + 百分比} placement="bottom">
            <span class="task-header-tokens-value" style={{ "font-weight": 600 }}>
              总计: {fmtDuration(t().total)}
            </span>
          </Tooltip>
        </div>
      </div>
    )
  }}
</Show>
```

#### 2.4.4 耗时明细悬浮框

```tsx
// 实际实现（TaskHeader.tsx 内联在 <Show when={liveTiming()}> 中）
const pct = (v: number) => t().total > 0 ? `(${((v / t().total) * 100).toFixed(1)}%)` : ""
return (
  <div style={{ "text-align": "left", "white-space": "nowrap" }}>
    <div>总耗时:       {fmtDuration(t().total)}</div>
    <hr style={{ margin: "2px 0", border: "none", "border-top": "1px solid currentColor", opacity: 0.3 }} />
    <div>● LLM 耗时:   {fmtDuration(t().llm)} {pct(t().llm)}</div>
    <div>● 工具执行:   {fmtDuration(t().tool)} {pct(t().tool)}</div>
    <Show when={t().wait > 0}>
      <div>● 等待用户:   {fmtDuration(t().wait)} {pct(t().wait)}</div>
    </Show>
    <div>● 实际执行:   {fmtDuration(t().actual)} {pct(t().actual)}</div>
    <Show when={t().total > t().llm + t().tool + t().wait}>
      <div>● 其他开销:   {fmtDuration(t().total - t().llm - t().tool - t().wait)} {pct(t().total - t().llm - t().tool - t().wait)}</div>
    </Show>
  </div>
)
```

> 实现说明：与初稿相比，tooltip 增加了「工具执行」行；「等待用户」仅在 `wait > 0` 时显示；
> 「其他开销」仅在 `total > llm + tool + wait` 时显示。时长格式化统一用 `fmtDuration()`（复用 session-utils 的 `buildTimingSegments` 数据）。

#### 2.4.5 耗时分段可视化条

> **实现说明**：初稿设想的独立分段色条（expanded 区域色条 + 图例）**未实现**。
> 实际改为更轻量的 inline 展示：在 TaskHeader 的 token 行下方直接渲染
> `任务累计耗时 | LLM: … | 工具执行: … | 等待用户: … | 总计: …`（见 §2.4.3 的"展示"部分），
> 明细 + 百分比悬浮在「总计」上显示。`buildTimingSegments()` 仅用于 inline 行的颜色与分段计算。

```tsx
// 实际实现（TaskHeader.tsx）：inline 展示行，无独立色条
// buildTimingSegments() 位于 session-utils.ts，固定四段 llm/tool/wait/overhead
// 颜色映射（含在 segments 内，无独立 TIMING_COLORS 常量）：
//   llm:      var(--syntax-property)
//   tool:     var(--syntax-info)
//   wait:     var(--syntax-warning, #d2a106)
//   overhead: var(--syntax-muted, #888)

// 分段条（初稿方案，未实现，仅存档参考）
<Show when={liveTiming()}>
  {(t) => {
    const segments = () => buildTimingSegments(t())
    return (
      <div class="flex flex-col gap-1">
        <div class="text-11-regular text-text-weaker">耗时分布</div>
        <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
          <For each={segments}>
            {(seg) => (
              <div
                class="h-full"
                style={{
                  width: `${seg.width}%`,
                  "background-color": seg.color,
                }}
              />
            )}
          </For>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1">
          <For each={segments}>
            {(seg) => (
              <div class="flex items-center gap-1 text-11-regular text-text-weak">
                <div class="size-2 rounded-sm" style={{ "background-color": seg.color }} />
                <span>{seg.label}</span>
                <span class="text-text-weaker">{seg.percent.toFixed(1)}%</span>
              </div>
            )}
          </For>
        </div>
      </div>
    )
  }}
</Show>
```

### 2.5 遥测埋点

#### 2.5.1 Metric 定义汇总

| Metric Name | Type | Description | Attributes |
|------------|------|-------------|-----------|
| `session.duration.total` | gauge | 会话总耗时(ms) | sessionID |
| `session.duration.llm` | gauge | LLM 累计耗时(ms) | sessionID, modelID, providerID |
| `session.duration.wait` | gauge | 等待用户耗时(ms) | sessionID |
| `session.duration.actual` | gauge | 实际执行耗时(ms) | sessionID |

> 实现说明：`total / wait / actual` 在 `run-state.ts` 的 `onIdle` 上报，属性仅 `sessionID`；
> `llm` 在 `processor.ts` 每次 stream 完成时上报，附带 `modelID` / `providerID`。

#### 2.5.2 数据流

```
processor.ts                   observability.ts              OTLP Exporter
┌──────────────┐              ┌──────────────────┐          ┌─────────────┐
│ Metric.update│ ──────────→ │ gauge 定义 +      │ ──────→ │ /v1/metrics │
│ (DELTA)      │              │ PeriodicExporting │          │ → ELK       │
└──────────────┘              │ 每10s导出         │          └─────────────┘
                              └──────────────────┘
```

### 2.6 涉及文件清单

| 文件路径 | 变更类型 | 变更内容 |
|---------|---------|---------|
| `packages/opencode/src/session/message-v2.ts` | 修改 | Assistant schema 新增 `time.llm` 字段 |
| `packages/opencode/src/session/processor.ts` | 修改 | Stream 完成后将 totalElapsed 写入 `time.llm` + 上报 `sessionLlmDuration` metric；`onInterrupt` 时写入部分耗时 |
| `packages/opencode/src/session/run-state.ts` | 修改 | `onIdle` 时上报 `sessionTotalDuration` / `sessionWaitDuration` / `sessionActualDuration`（通过 `busyStart` 记录） |
| `packages/core/src/effect/observability.ts` | 修改 | 新增 4 个 gauge Metric 定义 |
| `packages/kilo-vscode/webview-ui/src/types/messages.ts` | 修改 | Message 类型 `time` 字段新增 `llm?: number` |
| `packages/kilo-vscode/webview-ui/src/context/session-utils.ts` | 修改 | 新增 `TimingInfo`、`TimingSegment` 类型，`buildFamilyTiming()`、`buildTimingSegments()`、`fmtDuration()` |
| `packages/kilo-vscode/webview-ui/src/context/session.tsx` | 修改 | 新增 `familyTiming` computed + `tick` 信号（每秒重算）+ interface + export |
| `packages/kilo-vscode/webview-ui/src/components/chat/TaskHeader.tsx` | 修改 | 新增 `liveTiming` 实时计算 + 耗展示行 + tooltip + 空闲回退 |

### 2.7 变更影响范围

#### 向后兼容性

| 场景 | 影响 |
|------|------|
| 旧会话数据加载 | `time.llm` 为 `undefined`，前端 `?? 0` 处理，不报错 |
| 旧客户端连接新后端 | 同样缺失 `time.llm`，使用默认值 0 |
| 新客户端连接旧后端 | `time.llm` 字段不存在，前端忽略 |
| 数据库迁移 | SQLite schema 不需要迁移（`time` 字段是 JSON 内嵌在 message data 中） |

#### 风险点

| 风险 | 缓解措施 |
|------|---------|
| `time.llm` 累加可能略小于 `(completed - created)`，因为消息处理有非 LLM 开销 | 这是预期的——剩余算作"其他开销"，符合设计 |
| 子会话（subagent）的耗时也需要计入父会话 | `buildFamilyTiming()` 遍历 `family` set，已包含子会话 |
| 用户在 stream 未完成时中止，`time.llm` 可能未写入 | ✅ 已实现：`processor.ts` 的 `onInterrupt` 中写入部分耗时（`partialElapsed = Date.now() - streamStartTime`） |

---

## 附录 A：计算示例

### 示例 1：串行场景（无子会话）

```
第 1 次 LLM 调用：耗时 5.2s → 调用了 question 工具（等待用户 3.0s）
第 2 次 LLM 调用：耗时 4.1s → 调用了 bash 工具（执行 1.5s）
第 3 次 LLM 调用：耗时 3.8s → 回复完成

墙上时钟：最后 completed - 最早 created = 18.5s
LLM 累加：5.2 + 4.1 + 3.8 = 13.1s
等待累加：question tool(3.0s) = 3.0s
工具累加：1.5s（bash）
累加和：13.1 + 3.0 + 1.5 = 17.6s

最终总计 = max(18.5, 17.6) = 18.5s  （墙上时钟更大）
```

### 示例 2：有子会话（时间重叠）

```
父会话：  [==== LLM 30s ====== 等待子会话返回 ====================]  总 91s
子会话：       [== LLM 108s ==][=== 工具执行 95s ===][等待 27s]

墙上时钟：91s
LLM 累加：30 + 108 = 138s
工具累加：0 + 95 = 95s
等待累加：0 + 27 = 27s
累加和：138 + 95 + 27 = 260s

最终总计 = max(91, 260) = 260s  （累加和更大，子会话时间与父会话重叠）
```

## 附录 B：关键代码参考

### context breakdown 展示模式（复用）

**文件**: `packages/app/src/components/session/session-context-tab.tsx` 第 286-315 行

```tsx
<Show when={breakdown().length > 0}>
  <div class="text-12-regular text-text-weak">context.breakdown.title</div>
  <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
    <For each={breakdown()}>{(segment) => (
      <div class="h-full" style={{ width: `${segment.width}%`, "background-color": BREAKDOWN_COLOR[segment.key] }} />
    )}</For>
  </div>
  <div class="flex flex-wrap gap-x-3 gap-y-1">
    <For each={breakdown()}>{(segment) => (
      <div class="flex items-center gap-1 text-11-regular text-text-weak">
        <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
        <div>{breakdownLabel(segment.key)}</div>
        <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
      </div>
    )}</For>
  </div>
</Show>
```

### cost 悬浮展示模式（复用）

**文件**: `packages/kilo-vscode/webview-ui/src/components/chat/TaskHeader.tsx` 第 48-59 行

```tsx
const costTooltip = createMemo(() => {
  const items = breakdown()
  if (items.length <= 1) return <span>会话费用</span>
  const collapsed = collapseCostBreakdown(items, ...)
  return (
    <div style={{ "text-align": "left", "white-space": "nowrap" }}>
      <For each={collapsed}>{(e) => <div>{e.label}: {fmt(e.cost)}</div>}</For>
    </div>
  )
})
```

---

*以上设计基于 `testagent` 项目 v1 架构，所有 `testagent_change` 标记需在与上游 Kilo 同步时保留。*
