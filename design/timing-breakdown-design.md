# 会话耗时多维度拆分 — 需求与方案设计

> 版本：v2.0  
> 日期：2026-07-30  
> 状态：已实现

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
⏱ 任务耗时 37.3s | LLM: 27.2s (72.9%) | 工具执行: 4.1s (11.0%) | 等待用户: 3.0s (8.0%) | 其他开销: 3.0s (8.1%)

                        ↓ 悬浮 37.3s
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
> 因此百分比相加可能超过 100%。inline 行只展示时长不展示百分比，避免混淆。

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
  key: TimingKey       // "total" | "llm" | "wait" | "actual" | "tool"
  label: string        // 展示文案
  duration: number     // 毫秒值
  percent: number      // 百分比 (0-100)
  width: number        // 宽度百分比
  color: string        // 颜色值
}
```

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

**位置**: `packages/opencode/src/session/prompt.ts` 或 `processor.ts` — 会话完成/结束时

```typescript
// testagent_change start - 会话耗时上报
const timing = yield* computeSessionTiming(ctx.sessionID)
if (timing) {
  yield* Metric.update(
    Metric.withAttributes(sessionTotalDuration, {
      sessionID: ctx.sessionID,
      modelID: model?.id ?? "",
      providerID: model?.providerID ?? "",
    }),
    timing.total,
  )
  yield* Metric.update(
    Metric.withAttributes(sessionLlmDuration, {
      sessionID: ctx.sessionID,
      modelID: model?.id ?? "",
      providerID: model?.providerID ?? "",
    }),
    timing.llm,
  )
  yield* Metric.update(
    Metric.withAttributes(sessionActualDuration, {
      sessionID: ctx.sessionID,
      modelID: model?.id ?? "",
      providerID: model?.providerID ?? "",
    }),
    timing.actual,
  )
}
// testagent_change end
```

### 2.4 前端实现

#### 2.4.1 纯函数：计算耗时

**文件**: `packages/kilo-vscode/webview-ui/src/context/session-utils.ts`

新增 `buildFamilyTiming()` 函数（模式与 `buildFamilyTokens()` 完全相同）：

```typescript
/** 需要等待用户响应的工具列表 */
const WAIT_TOOLS = new Set(["question", "invalid"]) // testagent_change

/** 需要请求用户审批的工具类型 */
// 在 prompt.ts 中，ToolStateRunning 的 tool 通过 ctx.ask() 等待审批

/**
 * 计算会话族的总耗时、LLM耗时、等待耗时、实际耗时
 */
export function buildFamilyTiming(
  family: Set<string>,
  messages: Record<string, Array<{ role: string; time?: { created: number; completed?: number; llm?: number } }>>,
  parts: Record<string, Array<{ type: string; tool?: string; state?: { status: string; time?: { start: number; end: number } } }>>,
): TimingInfo | undefined {
  let total = 0
  let llm = 0
  let wait = 0

  for (const sid of family) {
    const msgs = messages[sid] ?? []

    for (const m of msgs) {
      if (m.role !== "assistant") continue
      // LLM 耗时
      llm += m.time?.llm ?? 0
      // 消息级耗时（用于总耗时计算）
      if (m.time?.created && m.time?.completed) {
        total = Math.max(total, m.time.completed)
      }
      // 等待工具耗时
      const msgParts = parts[m.id] ?? []
      for (const p of msgParts) {
        if (p.type === "tool" && WAIT_TOOLS.has(p.tool ?? "") && p.state?.time?.start && p.state?.time?.end) {
          wait += p.state.time.end - p.state.time.start
        }
      }
    }
  }

  // 总耗时 = 最后一条助理消息的完成时间 - 第一条用户消息的创建时间
  total = computeTotalDuration(family, messages)
  const actual = Math.max(0, total - wait)

  return { total, llm, wait, actual, tool: 0 } // tool 后续可精确计算
}
```

#### 2.4.2 前端耗时展示组件

**文件**: `packages/kilo-vscode/webview-ui/src/context/session.tsx`

在 context 中新增 `familyTiming`：

```typescript
// 新增 interface 字段
familyTiming: Accessor<TimingInfo | undefined>

// 实现
const familyTiming = createMemo<TimingInfo | undefined>(() => {
  const id = currentSessionID()
  if (!id) return undefined
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

#### 2.4.3 TaskHeader 修改

**文件**: `packages/kilo-vscode/webview-ui/src/components/chat/TaskHeader.tsx`

**关键逻辑**:

1. **实时计时器**：`setInterval` 每秒 tick（无条件运行）
2. **liveTiming memo**：不依赖 session busy 状态，直接从消息时间线和运行中工具估算
3. **空闲检测**：会话 idle 时回退到静态 `t.total`，避免停止后继续计时
4. **总计一致性**：`total = max(wallClock, llm + tool + wait)`，保证子会话重叠时数据自洽

```tsx
// 实时计时器
const [now, setNow] = createSignal(Date.now())
createEffect(() => {
  const id = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(id))
})

// 实时耗时
const liveTiming = createMemo(() => {
  const t = timing()
  const msgs = session.messages()
  const isIdle = session.status() === "idle"
  if (msgs.length === 0 && !t) return undefined
  if (isIdle && t) return t  // 空闲时回退静态数据

  // 总耗时取墙上时钟与累加和的最大值
  const since = session.busySince()
  const wallClock = since ? Date.now() - since : sessionStart ? Date.now() - sessionStart : 0
  const accumulated = (t?.llm ?? 0) + (t?.tool ?? 0) + (t?.wait ?? 0)
  const total = Math.max(wallClock, accumulated, t?.total ?? 0)

  return { total, llm: t?.llm ?? 0, wait: t?.wait ?? 0, tool: t?.tool ?? 0, actual: ... }
})

// 展示
<Show when={liveTiming()}>
  <span>⏱ 任务耗时</span>
  <Tooltip value={明细 + 百分比} placement="bottom">
    <span>{fmtDuration(t().total)}</span>
  </Tooltip>
  <span>|</span>
  <For each={segments()}>{(seg, index) => (
    <span style={{ color: seg.color }}>
      {index() !== 0 && <span>|</span>}
      {seg.label}: {fmtDuration(seg.duration)} ({seg.percent.toFixed(1)}%)
    </span>
  )}</For>
</Show>
```

#### 2.4.4 耗时明细悬浮框

```tsx
function timingTooltip(t: TimingInfo) {
  const fmt = (v: number) => `${(v / 1000).toFixed(1)}s`
  const pct = (v: number) => t.total > 0 ? ((v / t.total) * 100).toFixed(1) : "0.0"
  return (
    <div style={{ "text-align": "left", "white-space": "nowrap" }}>
      <div>总耗时:       {fmt(t.total)} ({pct(t.total)}%)</div>
      <hr style="margin:2px 0;border:none;border-top:1px solid currentColor;opacity:0.3" />
      <div>● LLM 耗时:   {fmt(t.llm)} ({pct(t.llm)}%)</div>
      <div>● 等待用户:   {fmt(t.wait)} ({pct(t.wait)}%)</div>
      <div>● 实际执行:   {fmt(t.actual)} ({pct(t.actual)}%)</div>
    </div>
  )
}
```

#### 2.4.5 耗时分段可视化条

参考 `SessionContextTab` 的 context breakdown 条的渲染方式，在 `TaskHeader` 的 expanded 区域新增耗时色条：

```tsx
// 耗时分段条颜色映射
const TIMING_COLORS: Record<string, string> = {
  llm: "var(--syntax-property)",
  wait: "var(--syntax-warning, #d2a106)",
  actual: "var(--syntax-success)",
  overhead: "var(--syntax-info)",
}

// 分段条
<Show when={timing()}>
  {(t) => {
    const segments = computeTimingSegments(t())
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
| `session.duration.total` | gauge | 会话总耗时(ms) | sessionID, modelID, providerID |
| `session.duration.llm` | gauge | LLM 累计耗时(ms) | sessionID, modelID, providerID |
| `session.duration.wait` | gauge | 等待用户耗时(ms) | sessionID, modelID, providerID |
| `session.duration.actual` | gauge | 实际执行耗时(ms) | sessionID, modelID, providerID |

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
| `packages/opencode/src/session/processor.ts` | 修改 | Stream 完成后将 totalElapsed 写入 `time.llm` + 上报 `sessionLlmDuration` metric |
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
| 用户在 stream 未完成时中止，`time.llm` 可能未写入 | `processor.ts` 的 `onInterrupt` 中补充写入逻辑 |

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
