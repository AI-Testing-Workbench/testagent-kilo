# 提案：`/sdt-run` 交互式阶段选择功能（最终实现）

> **版本:** v2.0  
> **日期:** 2026-07-07  
> **状态:** 已实现  

---

## 1. 背景

当前 `/sdt-run` 命令的使用方式是：

```
/sdt-run <stage_id>
```

用户必须手动输入阶段 ID，**不支持交互式选择**。用户在输入命令后，无法直观地看到当前任务有哪些阶段可选。

## 2. 目标

在 `/sdt-run` 命令输入或执行后，自动完成以下流程：

1. 调用 `testflow stages` 获取当前任务的阶段列表
2. 弹出交互式选择下拉框（类似 `@` 文件提及），支持键盘/鼠标选择
3. 默认选中第一个阶段
4. 用户选择后回填到输入框，按 Enter 发送完整命令
5. 如果直接点击发送按钮，作为备选通过 QuestionDock 让用户选择

---

## 3. 最终架构

### 3.1 双层交互设计

该功能采用**双层交互**策略，覆盖用户的所有操作路径：

**第一层：输入框下拉框（优先）**
- 用户输入 `/sdt-run` 或从斜杠命令列表选中后，**立即**在输入框上方展示阶段下拉框
- 用户选择一个阶段 → 文本变为 `/sdt-run <stage_id>` → 按 Enter 发送
- 体验类似 `@` 文件提及，即时、轻量

**第二层：QuestionDock 备选（兜底）**
- 如果用户未选择阶段直接点击发送按钮，Extension 端的 `handleInteractiveRun` 会拦截
- 自动调用 `testflow stages` 查询阶段列表
- 以 `questionRequest` 消息展示 QuestionDock，用户选择 → 自动执行

### 3.2 完整流程图

```
第一层（输入框下拉框）：
  用户输入 /sdt-run（或从斜杠命令列表选中）
    │
    ├─ useSdtStages.onInput 检测到文本以 /sdt-run 开头且无参数
    │    └─ postMessage({ type: "requestStages" })
    │
    ├─ Extension: handleRequestStages()
    │    └─ exec testflow stages --dir=<dir>
    │       └─ 解析 stdout 中的 JSON result 行
    │    └─ postMessage({ type: "stagesResult", stages: [...] })
    │
    ├─ 输入框上方弹出悬浮下拉框
    │    └─ 展示: stage_name (stage_id)  description
    │    └─ 键盘 ↑↓ 导航 / 鼠标点击 / Enter 选择 / Esc 取消
    │
    ├─ 选择阶段 → 文本变为 /sdt-run <stage_id>
    │    └─ 后续输入 -p xxx 等参数不会再次弹出下拉框
    │
    └─ 用户按 Enter → 正常发送命令至 Extension 执行

第二层（QuestionDock 兜底）：
  用户直接点击发送按钮（未选择阶段）
    │
    ├─ Extension: handleSdtCommand()
    │    └─ 检测 cmd === "run" && args.length === 0
    │    └─ handleInteractiveRun()
    │       ├─ queryOnce("stages", ...) 查询阶段
    │       ├─ 创建用户消息（postMessage messageCreated）
    │       ├─ 发送 questionRequest → webview 展示 QuestionDock
    │       └─ 等待用户选择
    │
    ├─ Webview: QuestionDock 渲染选项列表
    │    └─ 用户选择 → questionReply → Extension
    │
    └─ Extension: 执行 sdtRunner.run("run", [stageId], ...)
```

### 3.3 用户交互示意

```
第一层：输入框下拉框
┌─────────────────────────────────────────────────────┐
│  ┌─ stages-dropdown ──────────────────────────────┐ │
│  │  需求分析 (req-analysis)  分析用户需求            │ │
│  │  用例设计 (case-design)  设计测试用例  ← 选中    │ │
│  │  脚本编写 (script-write)  编写自动化脚本          │ │
│  └────────────────────────────────────────────────┘ │
│  ┌─ Prompt Input ─────────────────────────────────┐ │
│  │ /sdt-run case-design                         ↵ │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘

第二层：QuestionDock
┌─────────────────────────────────────────────────────┐
│  用户消息: /sdt-run                                │
│  ┌─ QuestionDock ─────────────────────────────────┐ │
│  │  选择执行阶段                                    │ │
│  │  ○ 需求分析      分析用户需求                     │ │
│  │  ● 用例设计      设计测试用例            ← 选中  │ │
│  │  ↑↓ 切换  Enter 确认  Esc 取消                   │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

---

## 4. 修改文件清单

### 4.1 testflow CLI 侧

| 文件 | 改动 | 风险 |
|------|------|------|
| `testflow/src/utils/result-event.ts` | 新增 `emitStagesResult()` 函数 | 低 |
| `testflow/src/core/cli/stages/index.ts` | 末尾调用 `emitStagesResult()` 输出 JSON Lines 结果 | 低 |
| `testflow/src/cli-entry.ts` | `stages` 命令跳过 `TraceReporter.report()` | 低 |

### 4.2 VS Code Extension 侧

| 文件 | 改动 | 风险 |
|------|------|------|
| `kilo-vscode/src/KiloProvider.ts` | ① `localQuestionMap` 字段 ② `handleSdtCommand` 交互分支 ③ `handleInteractiveRun()` ④ `handleRequestStages()` ⑤ `questionReply/Reject` 本地支持 | 中 |
| `kilo-vscode/src/testagent/sdt-runner.ts` | ① `"stages"` 加入 `ONE_SHOT_COMMANDS` ② 新增 `queryOnce()` 方法 | 低 |
| `kilo-vscode/webview-ui/src/types/messages.ts` | 新增 `RequestStagesMessage` / `StagesResultMessage` 类型 | 低 |
| `kilo-vscode/webview-ui/src/hooks/useSdtStages.ts` | **新文件** — 监控输入框文本，检测到 `/sdt-run` 时请求阶段列表并显示下拉框 | 低 |
| `kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx` | 集成 hook、`onInput`/`onKeyDown` 调度、下拉框渲染、关闭逻辑 | 低 |
| `kilo-vscode/webview-ui/src/styles/prompt-dropdowns.css` | 新增 `.stages-dropdown` / `.stages-item` 样式 | 低 |

---

## 5. 详细实现

### 5.1 testflow CLI — `emitStagesResult()`

```typescript
// result-event.ts
export function emitStagesResult(payload: {
  taskName: string
  stages: { stage_id: string; stage_name: string; description: string }[]
}): void {
  emit({ kind: 'stages', ...payload })
}
```

```typescript
// stages/index.ts — getStagesCommand 末尾追加
emitStagesResult({
  taskName: resolvedTaskName,
  stages: stages.map(s => ({
    stage_id: s.stage_id,
    stage_name: s.stage_name,
    description: s.description ?? '',
  })),
})
```

> 仅在 `KILO_INTEGRATION=1` 时输出 JSON，CLI 直跑时无影响。

### 5.2 testflow CLI — 跳过 TraceReporter

```typescript
// cli-entry.ts
// 成功路径
if (resolvedId !== 'observe' && resolvedId !== 'stages') {
  await TraceReporter.report({ ... })
}
// 失败路径
if (resolvedId !== 'observe' && resolvedId !== 'stages') {
  await TraceReporter.report({ ... })
}
```

> `stages` 是查询命令，不需要上报追踪，避免网络超时阻塞进程退出。

### 5.3 SdtRunner — `queryOnce()`

```typescript
// sdt-runner.ts
const ONE_SHOT_COMMANDS = new Set(["init", "new", "list", "switch", "validate", "stages"])

async queryOnce(opts: SdtRunnerOpts): Promise<Record<string, unknown>> {
  // spawn 子进程，逐行读取 stdout
  // 收集 type === "result" 的 JSON 事件
  // 进程退出时 resolve 或 reject
  // 不启动 bridge，不创建 UI 消息
}
```

### 5.4 useSdtStages Hook（Webview 侧）

```typescript
// useSdtStages.ts — 监控文本模式
// 正则: /^\/sdt-run\s*/ — 匹配以 /sdt-run 开头的文本
//
// onInput:
//   - 文本以 /sdt-run 开头且无后续参数 → 请求 stages + 显示下拉框
//   - 文本以 /sdt-run 开头且有参数 → 关闭下拉框
//   - 否则 → 关闭下拉框
//
// onKeyDown:
//   ArrowDown/Up → 导航选项
//   Enter/Tab → 选择 stage，回填 /sdt-run <stage_id>
//   Escape → 关闭
```

### 5.5 KiloProvider — 关键改动

**`handleSdtCommand` 交互分支：**

```typescript
// 仅在 args.length === 0（无 stage_id 参数）时触发
if (cmd === "run" && args.length === 0) {
  await this.handleInteractiveRun(resolved, serverConfig, { ... })
  return
}
```

**`handleRequestStages`（响应 webview 下拉框）：**

```typescript
// 使用 exec 执行 testflow stages --dir=<dir>
// 从 stdout 中逐行解析 JSON, 查找 type === "result" && kind === "stages"
// 找到后立即 postMessage({ type: "stagesResult", stages, taskName, requestId })
```

**`handleInteractiveRun`（QuestionDock 兜底）：**

```typescript
// 1. queryOnce("stages", ...) 查询阶段
// 2. 无阶段 → error
// 3. 一个阶段 → 直接执行（args: [stageId]）
// 4. 多个阶段 → 先创建用户消息 → 发送 questionRequest → await 用户选择
// 5. 选择后 → sdtRunner.run("run", [stageId], ...)
//
// 注意: args 只传 stage_id，不传 taskName。
//       testflow run 的 taskName 由 CLI 自动从 .sdt_config.yaml 解析。
```

**`questionReply`/`questionReject` 本地拦截：**

```typescript
case "questionReply":
  if (requestID.startsWith('sdt-local:')) {
    // 从 localQuestionMap 取出 deferred，resolve 或 reject
    break  // 不调用 server 的 question.reply()
  }
  // 原有 server-side flow
  ...

case "questionReject":
  if (requestID.startsWith('sdt-local:')) {
    // reject deferred
    break
  }
  // 原有 server-side flow
  ...
```

### 5.6 PromptInput.tsx — 集成点

```typescript
// 1. 初始化 hook
const sdtStages = useSdtStages(vscode, ...)

// 2. handleInput 中加入 onInput 调度
sdtStages.onInput(val, target.selectionStart ?? val.length)

// 3. handleKeyDown — stages 优先于 file mention
if (slash.onKeyDown(...)) { sdtStages.onInput(...); return }
if (sdtStages.onKeyDown(...)) { return }  // 新增
if (mention.onKeyDown(...)) { ... }

// 4. 键盘 Enter/Tab 选择斜杠命令后触发查询
if (slash.onKeyDown(e, textareaRef, setText, adjustHeight)) {
  if (textareaRef) {
    sdtStages.onInput(textareaRef.value, ...)
  }
  return
}

// 5. 鼠标点击斜杠命令后触发查询
onMouseDown={(e) => {
  e.preventDefault()
  if (textareaRef) {
    slash.select(cmd, textareaRef, setText, adjustHeight)
    sdtStages.onInput(textareaRef.value, ...)  // 新增
  }
}}

// 6. handleSend 中关闭下拉框
sdtStages.closeStages()  // 新增，与 mention.closeMention()、slash.close() 并列
```

---

## 6. 向后兼容

- `/sdt-run <stage_id>`：直接执行，不触发交互式选择（原有流程）
- `/sdt-run <stage_id> -p xxx`：直接执行，输入框下拉框不会弹出
- `/sdt-list`、`/sdt-new`等：不受影响

## 7. 开发过程中发现的 Bug 及修复

| Bug | 根因 | 修复 |
|-----|------|------|
| 选择 `/sdt-run` 后下拉框不弹出 | `slash.select()` 不触发 InputEvent，`sdtStages.onInput` 未被调用 | 在 `handleKeyDown` 和 `onMouseDown` 中 `select()` 后主动调用 `onInput()` |
| 发送按钮点击后下拉框不关闭 | `handleSend` 缺少 `sdtStages.closeStages()` | 补充关闭调用 |
| 新会话发送 `/sdt-run` 后无消息展示 | `session.sendCommand` 中 `if (sid) addOptimistic(...)` 因 `sid` 为 null 不创建 | `handleInteractiveRun` 中先 `postMessage messageCreated` 创建用户消息 |
| 选择 stage 后继续输入 `-p` 参数又弹出下拉框 | `onInput` 中正则匹配了所有 `/sdt-run` 开头的文本 | 检查 `/sdt-run` 后是否已有参数，有则关闭下拉框 |
| QuestionDock 选择后参数组装错误 | `args: [taskName, stageId]` 多传了 `taskName` | 改为 `args: [stageId]`，taskName 由 CLI 自动解析 |
| `testflow stages` 查询耗时 10 秒 | `TraceReporter.report()` 网络超时阻塞进程退出 | `cli-entry.ts` 中 `stages` 跳过 TraceReporter |

## 8. 测试验证

### 第一层（输入框下拉框）

| 测试用例 | 期望结果 |
|----------|----------|
| 输入 `/sdt-r` → Enter 选择 `/sdt-run` | 下拉框立即弹出，展示阶段列表 |
| 键盘 ↑↓ 导航 → Enter 选择 | 文本变为 `/sdt-run <stage_id>` |
| 鼠标点击选择 | 文本变为 `/sdt-run <stage_id>` |
| 选择后继续输入 `-p xxx` | 下拉框不再次弹出 |
| Escape 取消 | 下拉框关闭 |
| 点击发送按钮 | 下拉框关闭，消息发出 |
| 仅一个阶段 | 下拉框正常弹出（无特殊处理） |

### 第二层（QuestionDock 兜底）

| 测试用例 | 期望结果 |
|----------|----------|
| 直接发送 `/sdt-run`（不选阶段） | 聊天区显示 `/sdt-run` 用户消息 + QuestionDock |
| QuestionDock 中选择阶段 | 自动执行对应阶段 |
| QuestionDock Escape 取消 | 不执行任何阶段 |

### 向后兼容

| 测试用例 | 期望结果 |
|----------|----------|
| `/sdt-run myStageId` | 直接执行，不弹下拉框和 QuestionDock |
| `/sdt-run myStageId -p foo` | 直接执行 |
| `/sdt-list` | 不变 |