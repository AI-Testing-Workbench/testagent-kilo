# 对话耗时细分维度增强方案

## 现状分析

### 已实现的能力
1. **Backend metrics（effect.metric）**：
   - `sessionTotalDuration` — 会话总耗时（含用户等待）
   - `sessionLlmDuration` — LLM 总耗时（累加每次 LLM 流式调用）
   - `sessionWaitDuration` — 等待用户耗时（仅统计 `question` / `invalid` 工具）
   - `sessionActualDuration` — 实际执行耗时（= total - wait）
   - `ttft` — 首 token 时间
   - 以上均为 `Metric.gauge`，通过 OTLP 导出到 ELK

2. **前端展示（TaskHeader）**：
   - Token  breakdown（输入/输出/缓存读写/总计）
   - 耗时分段柱状图（LLM / 工具执行 / 等待用户 / 其他开销）
   - 悬浮 tooltip 显示各段耗时 + 百分比
   - 实时计时器（活跃时每秒更新）

3. **时间数据流**：
   - Backend: `processor.ts` 记录 `message.time.llm`，`run-state.ts` 在 idle 时计算并上报 metrics
   - Frontend: `buildFamilyTiming()` 遍历 messages + parts 计算 timing

### 缺失的能力
1. **Permission 等待耗时未统计**：当前 `run-state.ts` 只扫描 `question` / `invalid` 工具 parts，权限请求（`permission.asked`）是独立事件流，不在 tool parts 中
2. **Permission 等待未纳入 `actual` 计算**：`actual = total - wait` 中的 `wait` 不含 permission 时间
3. **任务耗时未在 token 区域展示**：当前 token 区域只显示 tokens，不同步显示耗时
4. **Tooltip 可进一步丰富**：当前 tooltip 已有百分比，但可增加更细的 LLM 调用明细

## 实现方案

### 1. Backend: 跟踪 Permission 等待耗时

**文件**: `packages/testagent-core/packages/opencode/src/cli/cmd/run/stream.transport.ts`

在 `State` 中新增 `permissionStartTimes: Map<string, number>` 和 `permissionDurations: Map<string, number>`。

- `permission.asked` 事件：记录 `permissionStartTimes.set(id, Date.now())`
- `permission.replied` / `permission.rejected` 事件：计算 duration，存入 `permissionDurations`，并从 `permissionStartTimes` 删除
- 在 `reduceSessionData` 中处理这些事件时同步更新时间

**关键代码位置**：
- `stream.transport.ts:107` — State 类型定义处新增字段
- `stream.transport.ts:444` — `seedBlocker` 附近记录 permission start time
- `stream.transport.ts:465` — `releaseBlocker` 附近计算 permission duration

### 2. Backend: 新增 Permission 耗时 Metric

**文件**: `packages/testagent-core/packages/core/src/effect/observability.ts`

新增：
```typescript
export const sessionPermissionDuration = Metric.gauge("session.duration.permission", {
  description: "Time spent waiting for permission approval (ms)",
})
```

**文件**: `packages/testagent-core/packages/opencode/src/cli/cmd/run/stream.transport.ts`

在每个 permission 回复时上报：
```typescript
yield* Metric.update(
  Metric.withAttributes(sessionPermissionDuration, { sessionID: input.sessionID }),
  duration,
)
```

**文件**: `packages/testagent-core/packages/opencode/src/session/run-state.ts`

在 `onIdle` 的 wait time 计算中，增加 permission duration 的统计。由于 `run-state.ts` 无法直接访问 transport 的 permission 数据，采用以下方案：

**方案 A（推荐）**：在 `stream.transport.ts` 中，当 permission 被回复时，直接上报 `sessionPermissionDuration` metric（不需要等到 session idle）。同时将 permission duration 累加到 `sessionWaitDuration` 中。

修改 `run-state.ts` 的 wait time 计算：
```typescript
// 现有：只统计 question/invalid 工具
// 新增：也统计 permission 等待（从 messages 中查找带有 permission time 的信息）
```

但 permissions 不在 messages 中... 

**方案 B（实际可行）**：将 permission 的 start/end time 写入 `PermissionRequest.metadata`，然后在 `run-state.ts` 的 wait time 扫描中，通过 SDK API 获取 pending permissions 的时间。

但 `run-state.ts` 没有 SDK client 访问权限...

**方案 C（最简）**：
1. 在 `stream.transport.ts` 中维护 session 级的 permission 等待累加器
2. 每次 permission 回复时，上报 `sessionPermissionDuration` metric
3. 同时通过某种方式（例如写入 session metadata 或通过 bus event）将 permission wait time 传递给 `run-state.ts`
4. 或者：直接在 `stream.transport.ts` 中计算总 permission wait，然后在 session idle 时通过一个共享状态传递给 `run-state.ts`

经过权衡，**推荐方案 C 的简化版**：
- 在 `stream.transport.ts` 中，session 级别的 `permissionWaitTotal` 累加器
- 当 permission 回复时，同时更新 `sessionWaitDuration` metric（增量更新）
- 这样 `run-state.ts` 上报的 `sessionWaitDuration` 已经包含了 permission wait

### 3. Frontend: 在 buildFamilyTiming 中增加 Permission Wait

**文件**: `packages/kilo-vscode/webview-ui/src/context/session-utils.ts`

当前 `WAIT_TOOLS = new Set(["question", "invalid"])`。

由于 permission 不是 tool part，需要在 `buildFamilyTiming` 中单独处理：
- 遍历 permissions，计算每个 permission 的等待时间
- 将 permission wait 加入 `wait` 总和

但前端 permissions 数据没有 time 字段...

**方案**：
1. 在 `PermissionRequest` 的 `metadata` 中存储 `time: { start, end, duration }`
2. 前端从 permission metadata 中读取时间
3. 在 `buildFamilyTiming` 中增加 permission wait 统计

### 4. Frontend: Token 区域展示任务耗时

**文件**: `packages/kilo-vscode/webview-ui/src/components/chat/TaskHeader.tsx`

在 token breakdown 区域，新增一个耗时展示条目：
```tsx
<div class="task-header-tokens">
  <span class="task-header-tokens-label">任务累计消耗</span>
  <span class="task-header-tokens-value">⏱ {fmtDuration(totalDuration)}</span>
  {/* 现有 token 展示 */}
</div>
```

### 5. Frontend: 增强 Tooltip 明细

**文件**: `packages/kilo-vscode/webview-ui/src/components/chat/TaskHeader.tsx`

当前 tooltip 已有：
- 总耗时
- LLM 耗时 + 百分比
- 工具执行 + 百分比
- 等待用户 + 百分比
- 实际执行 + 百分比
- 其他开销 + 百分比

增强为：
- 增加 LLM 调用次数和平均耗时
- 增加 permission 等待次数和总耗时
- 增加 question 等待次数和总耗时
- 各子项更明细的拆分

### 6. Backend: 在 message.time 中增加细分字段（可选）

如果需要更细粒度的 LLM 耗时拆分（如 TTFT、streaming 时间），可以在 `Assistant` message 的 `time` 字段中增加：
- `ttft` — 首 token 时间
- `streaming` — 流式传输总时间（已有 `llm` 字段，可重命名或拆分）

当前已有 `time.llm`，可以在此基础增加 `time.ttft`。

## 数据流图

```
permission.asked ──→ stream.transport.ts ──→ permissionStartTimes.set(id, now)
                                               │
permission.replied ─→ stream.transport.ts ──→ duration = now - start
                                               │
                                               ├─→ Metric.update(sessionPermissionDuration, duration)
                                               ├─→ Metric.update(sessionWaitDuration, duration)  // 增量
                                               └─→ permission metadata 添加 time 字段
                                                    
Frontend:
permissionRequest ──→ 记录 startTime
permissionResolved ──→ 计算 duration，加入 wait 总和

buildFamilyTiming():
  llm = Σ message.time.llm
  tool = Σ tool parts duration (非 wait tools)
  wait = Σ question/invalid tool duration + Σ permission duration
  total = max(墙上时钟, llm + tool + wait)
  actual = total - wait
```

## 实施步骤

1. **Backend - stream.transport.ts**：新增 permission 时间跟踪 map，在 asked/replied 事件中记录
2. **Backend - observability.ts**：新增 `sessionPermissionDuration` metric
3. **Backend - stream.transport.ts**：permission 回复时上报 metric
4. **Backend - run-state.ts**：确保 wait duration 包含 permission（通过增量更新）
5. **Frontend - session-utils.ts**：`buildFamilyTiming` 增加 permission wait 统计
6. **Frontend - TaskHeader.tsx**：token 区域增加耗时展示
7. **Frontend - TaskHeader.tsx**：增强 tooltip 明细
8. **SDK 类型更新**（如需要）：在 `PermissionRequest` 中增加 time 字段（或使用 metadata）

## 风险与注意

1. **Permission 不是 Tool**：permission 请求发生在 tool 执行之前，是独立的交互流程。不能简单地在 tool parts 中查找
2. **子会话权限**：子会话（subagent）的 permission 也需要跟踪，`stream.transport.ts` 已有 `subagent` 数据结构，需一并处理
3. **SSE 重连恢复**：permission 请求在 SSE 重连后可能丢失 start time，需要处理边界情况
4. **SDK 类型兼容**：如果修改 `PermissionRequest` 类型，需要重新生成 SDK

## 验证计划

1. 模拟一个包含 permission 请求的对话流程
2. 检查 ELK 中 `session.duration.permission` metric 是否上报
3. 检查 TaskHeader tooltip 中 permission wait 是否显示且百分比正确
4. 检查 `actual` 耗时是否正确排除了 permission 等待时间
5. 检查 token 区域的耗时展示是否正常显示
