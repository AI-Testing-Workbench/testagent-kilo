# TestAgent YOLO 模式集成方案（已完成实现）

> 目标：在 testagent-kilo（kilo-vscode 前端 + testagent-core 后端 CLI）中集成 cline 的 YOLO 模式，
> 功能与 cline yolo mode 对齐，在 PromptInput 提供开关。
>
> **开关语义（用户拍板）**：**全局开关**——开启后【所有会话】均采用 YOLO 模式，
> 与当前会话无关（没有活动会话也能切换）；进程级生命周期，**重启 VS Code 才重置**，手动关闭才退出。

---

## 一、背景：cline YOLO 模式的实现原理

cline 的 YOLO（`AgentMode = "yolo"`）由三层独立机制构成：

| 层 | 作用 | cline 位置 |
|---|---|---|
| 工具预设 | 决定注册哪些工具：`enableAskQuestion: false`、`enableSkills: false`、`enableSubmitAndExit: true` | `sdk/packages/core/src/extensions/tools/presets.ts` `ToolPresets.yolo` |
| 工具策略 | `toolPolicies: { "*": { autoApprove: true } }`，审批决策时跳过 `requestToolApproval` 直接执行 | `presets.ts` `createToolPoliciesWithPreset` + `agents/src/agent-runtime.ts` ~L1745 |
| 系统提示词 | 专用 `YOLO_CLINE_SYSTEM_PROMPT`：明确"你无法与用户直接沟通、干完活必须 `submit_and_exit` 收尾" | `shared/src/prompt/system.ts:38` |

**skill 里要求"用 question 工具提问用户"时 cline 的处理**：
1. yolo 预设下 `ask_question` 根本不注册，模型看不到该工具 schema；
2. 模型若仍臆造调用 → agent-runtime 返回 `Unknown tool: ask_question`（`isError: true`）回灌给模型；
3. 模型在"无法沟通"的提示词约束下，自主做出最合理假设并继续，直到 `submit_and_exit`。
   不会崩溃、不会卡死，但**也不会真的问到人**。

---

## 二、架构差异与映射

testagent-core 基于 opencode 的 **permission 模型**（`ask`/`allow`/`deny` 规则 + Deferred 挂起 + `permission.asked` 事件），
与 cline 的 `toolPolicies` 是两种范式，但概念一一对应：

| cline | testagent-core 对应物 | 现状 |
|---|---|---|
| `autoApprove: true` 跳过审批回调 | `Permission.ask` 的 evaluate/挂起流程 | ✅ 已有，加"YOLO 短路" |
| `enableAskQuestion: false` 工具不注册 | `question` 工具 + `Question.ask` 挂起 Deferred 等回复 | ✅ 已有，加"工具列表过滤 + 自动答复兜底" |
| `YOLO_CLINE_SYSTEM_PROMPT` | system prompt 组装（`session/prompt.ts`） | ✅ 已有，追加 YOLO 约束段 |
| `submit_and_exit` 收尾 | session 自然完成机制 | 无需移植，提示词改用"完成即结束"语义 |

### 架构决策 1：进程级纯模块状态（不用 InstanceState / Effect Service）

- 前端开关请求走 `PUT /testagent/yolo`（root 路由，**无 per-instance 目录上下文**，与 zhAnswer 同模式）；
- permission/llm/prompt/question 的检查点都在 session 上下文内；
- 因此状态必须是**进程级全局变量**（纯模块 `let enabled = false`）：
  任何上下文都能同步调用 `Yolo.isEnabled()`，不产生 layer 组合问题。
- 开关事件通过 `GlobalBus`（进程级）广播，与 `zh.answer.toggled` 同模式。
- 状态为**内存态**：CLI 进程 / VS Code 重启后复位（与用户要求的生命周期一致）。

### 架构决策 2：全局布尔，不按 session 隔离（v2 修正）

v1 设计为 per-session Map，导致两个 bug：
1. **点击无反应**：`toggle()` 里 `if (!currentSessionID()) return`，没有活动会话时静默无效；
2. **按钮假死**：`disabled={!server.isConnected() || ...}`，`connectionState` 初始为 `"connecting"`，webview 重挂载后常长时间不为 `"connected"`，按钮直接禁用。

用户拍板语义改为**全局开关**后两个 bug 自然消解：切换不再依赖 sessionID，按钮只受 `busy()` 约束。

---

## 三、后端实现（`packages/testagent-core/packages/opencode/`）

共享文件改动均带 `testagent_change` 标记；`src/testagent/` 为专属目录无需标记。

### 3.1 状态管理 — `src/testagent/yolo.ts`（纯模块全局布尔）

```ts
let enabled = false

export const Event = {
  Enabled: "testagent.yolo.enabled" as const,
  Disabled: "testagent.yolo.disabled" as const,
}

/** 设置 YOLO 全局开关（幂等） */
export function set(next: boolean): void {
  if (enabled === next) return
  enabled = next
  log.info(next ? "yolo enabled (global)" : "yolo disabled (global)")
  GlobalBus.emit("event", {
    payload: { type: next ? Event.Enabled : Event.Disabled, properties: {} },
  })
}

/** 当前 YOLO 开关状态（同步读，无 Effect 上下文依赖） */
export function isEnabled(): boolean {
  return enabled
}

/** 重置为关闭（进程退出钩子等场景使用，可选） */
export function reset(): void {
  enabled = false
}
```

### 3.2 Permission 短路 — `src/permission/index.ts`（核心）

在 `ask()` 入口最前面短路（**在规则评估之前**，deny 同样被绕过）：

```ts
const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
  // testagent_change start - YOLO 模式（全局开关）：绕过所有权限规则（包括 deny），直接放行
  if (Yolo.isEnabled()) {
    log.info("yolo bypass", { permission: input.permission, sessionID: input.sessionID })
    return
  }
  // testagent_change end
  const { approved, pending } = yield* InstanceState.get(state)
  // ...原有 evaluate / 挂起 / 发 permission.asked 逻辑不变
})
```

**语义**：YOLO 开启时不评估任何规则（显式 `deny` 也被绕过——对齐用户明确的
"绕过所有权限规则（包括 deny）"文案）、不挂起 Deferred、不发 `permission.asked` 事件
（前端不出现审批卡片）、每次放行打结构化日志便于复盘。

### 3.3 Question 兜底 — `src/question/index.ts`

在 `ask()` 入口短路：

```ts
const ask = Effect.fn("Question.ask")(function* (input: {
  sessionID: SessionID
  questions: ReadonlyArray<Info>
  tool?: Tool
}) {
  // testagent_change start - YOLO 模式（全局开关）：用户不在场，新问题直接按第一个选项自动答复
  // （与 cline yolo 的 question 处理一致；工具列表过滤是第一道，这里是兜底，
  // 覆盖模型臆造调用时工具仍存在的路径，如子 agent / plugin 注入的工具）
  if (Yolo.isEnabled()) {
    const answers = input.questions.map((q) => (q.options.length > 0 ? [q.options[0].label] : []))
    log.info("yolo auto-answered", { sessionID: input.sessionID, count: input.questions.length })
    return answers
  }
  // testagent_change end
  // ...原有挂起逻辑不变
})
```

**question 完整的三层防线**（对应 cline 的"工具不注册 + Unknown tool 回退"，且多一层保险）：

| 层 | 机制 | 与 cline 对照 |
|---|---|---|
| 第一道 | `llm.ts` 工具列表过滤：YOLO 下 `delete tools.question`，模型看不到 schema | = cline `enableAskQuestion: false` |
| 第二道 | 模型臆造调用时 AI SDK 抛 `NoSuchToolError` → 流内 `tool-error` 事件 → processor `failToolCall` 回灌 `Unknown tool` 错误 | = cline `Unknown tool: ask_question` 回退 |
| 第三道 | `Question.ask` 入口自动答第一个选项（即使工具经其他路径存在） | cline 无此层（多出来的保险） |

### 3.4 工具列表过滤 — `src/session/llm.ts`

```ts
const tools = resolveTools(input)
// testagent_change start - YOLO 模式（全局开关）：question 工具对模型不可用（与 cline yolo 一致）。
// 模型若仍臆造 question 调用，AI SDK 会抛 NoSuchToolError 并转为流内 tool-error 事件，
// 由 processor 的 failToolCall 把 "Unknown tool" 错误结果回灌给模型自主决策。
if (Yolo.isEnabled()) {
  delete tools.question
  l.info("yolo: question tool hidden")
}
// testagent_change end
```

### 3.5 系统提示词 — `src/testagent/yolo-prompt.ts` + `src/session/prompt.ts`

`yolo-prompt.ts` 导出 `SECTION`（对齐 `YOLO_CLINE_SYSTEM_PROMPT` 语义）：

```
YOLO MODE is enabled for this session. You are working unattended in the background:
- The user is NOT present and you CANNOT communicate with them directly. Do not pause
  to ask for confirmation, approval, or clarification on any action.
- All tool permissions have been auto-approved for this session, including rules that
  would normally ask or deny. You may execute any tool call without asking.
- The question tool is NOT available in this mode. If a decision genuinely requires
  user input, make the most reasonable assumption yourself, state the assumption
  explicitly in your response, and continue.
- After making changes, verify them: run the relevant tests or build. If they fail,
  analyze the failures, fix your changes, and re-run until they pass.
- When the task is complete, finish with a concise summary of the changes made, the
  assumptions you took, and the verification results.
```

`prompt.ts` system 数组组装处追加：

```ts
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
// testagent_change start - YOLO 模式（全局开关）追加系统提示词约束段
if (Yolo.isEnabled()) {
  system.push(YoloPrompt.SECTION)
}
// testagent_change end
```

**skill 里写"用 question 工具提问"时的实际行为**（与 cline 完全一致）：
skill 文本仍会进上下文（用户可见），模型读到该指令后尝试调用 `question` →
收到 `Unknown tool` 错误回灌 → 在提示词约束下自主做出假设并在回复中显式说明、继续执行。

### 3.6 API 路由 — `httpapi/groups/testagent.ts` + `httpapi/handlers/testagent.ts`

```
PUT  /testagent/yolo     body: { enabled }   → { applied: true }
GET  /testagent/yolo                       → { enabled: boolean }
```

- 两个 endpoint 挂在已有 `testagent` 路由组（root 路由，无实例上下文依赖），
  handler 直接调纯模块 `Yolo.set` / `Yolo.isEnabled`；
- payload **不含 sessionID**（全局开关）；
- GET 供 webview 重挂载 / 切会话时恢复开关状态；
- 改完跑 `bun run script/generate.ts` 重新生成 SDK（`packages/sdk/js/`），
  生成 `client.testagent.yolo.set/get`。

### 3.7 单元测试 — `test/testagent/yolo.test.ts`（6 用例，全过）

| 用例 | 验证点 |
|---|---|
| set/isEnabled 幂等且全局生效 | 重复 set 幂等；reset 复位 |
| YOLO 关闭时显式 deny 规则照常生效（回归保护） | `ask` 带 deny ruleset 走 `Permission.defaultLayer`，`Exit.isFailure` |
| YOLO 开启时同一 deny 规则被绕过 | 不抛错、不产生 pending（`svc.list()` 过滤本会话为空） |
| YOLO 开启时 ask 规则不挂起直接放行 | 带 ask ruleset 的 `ask` 同步返回（<200ms），证明短路在挂起之前 |
| question：YOLO 开启时新问题自动按第一个选项答复 | `Question.Service.ask` 返回 `["方案A"]` |
| question：YOLO 开启时无选项问题返回空答案 | 返回 `[]` 不挂起 |

测试骨架：`provideTestInstance({ directory, fn })` + `Effect.runPromise` + `Permission.defaultLayer` / `Question.defaultLayer`。

---

## 四、前端实现（`packages/kilo-vscode/`）

### 4.1 PromptInput 开关

`webview-ui/src/components/chat/PromptInput.tsx` 底部工具栏（`prompt-input-hint-actions`，
ContextRing 右侧）：

```tsx
<Tooltip
  value={
    yolo.enabled()
      ? "YOLO 模式已开启：所有会话的所有权限自动放行（含 deny 规则），question 工具不可用，智能体全程自主执行"
      : "开启 YOLO 模式：所有会话跳过权限审批、不允许向用户提问，智能体全程自主执行（无人值守，重启 VS Code 后重置）"
  }
  placement="top"
>
  <Button
    variant="ghost"
    size="small"
    class={`prompt-input-yolo ${yolo.enabled() ? "prompt-input-yolo--active" : ""}`}
    onClick={() => yolo.toggle(!yolo.enabled())}
    disabled={yolo.busy()}
    aria-label="YOLO 模式"
    aria-pressed={yolo.enabled()}
  >
    <ShieldCheck size={16} />
    <span class="prompt-input-yolo-tag">YOLO</span>
  </Button>
</Tooltip>
```

- 图标：`ShieldCheck`（lucide，`packages/kilo-ui/src/lucide.ts` 已导出）；
- 开启态：图标 + "YOLO" 文字变绿色（`--vscode-charts-green`），样式在 `styles/prompt-input.css` 末尾；
- **`disabled` 只受 `yolo.busy()` 约束**——无活动会话也能切换（v2 修正，原条件
  `!server.isConnected() || yolo.busy()` 是"点击无反应"的根因之一）。

### 4.2 `webview-ui/src/hooks/useYolo.ts`

状态同步机制（全局语义，**不再依赖 sessionID**）：

1. **乐观更新**：点击立即 `setYolo(next)` + `postMessage(requestYoloToggle)`，不等后端，
   tooltip 与按钮高亮即时切换；
2. **回包校正**：监听 `yoloStatus` 事件，收到 `ok` 回包即 `setYolo(message.enabled)` 并解除 busy；
3. **状态恢复**：`createEffect(on(() => ctx.currentSessionID(), ...))` —— webview 重挂载 /
   切会话时自动发 `requestYoloStatus` 查询（后端为单一事实源，extension host 内存优先）；
4. **兜底对账**：3s 后若 busy 仍未解除（回包丢失），主动查询一次。

### 4.3 KiloProvider（extension 侧）—— 内存态事实源 + 后端双写

```ts
// testagent_change start - YOLO 模式开关（全局开关，与 session 无关）
// 状态设计：extension host 内存持有为事实源（VS Code 重启才重置），
// 同时双写后端 server（reload window 后 webview 重挂载时从后端恢复，保证不断档）。
private yoloEnabled = false

/** 切换 YOLO 全局开关，并把最新状态回推给 webview */
private async handleYoloToggle(enabled: boolean): Promise<void> {
  this.yoloEnabled = enabled
  this.postMessage({ type: "yoloStatus", ok: true, enabled, requestId: "" })
  const client = this.client
  if (!client) return
  try {
    await client.testagent.yolo.set({ directory: this.getWorkspaceDirectory(), enabled })
  } catch (error) {
    console.error("[TestAgent] yolo sync to server failed:", error)
  }
}

/** 查询 YOLO 状态：extension 内存优先，未初始化/查询失败时回退后端 */
private async handleYoloStatus(requestId: string): Promise<void> {
  const client = this.client
  if (!client) return
  try {
    const res = await client.testagent.yolo.get({ directory: this.getWorkspaceDirectory() })
    const serverEnabled = res.data?.enabled ?? false
    // 后端比 extension 新（例如 CLI 侧直接调用 API 改过状态）时以后端为准
    this.yoloEnabled = this.yoloEnabled || serverEnabled
    this.postMessage({ type: "yoloStatus", ok: true, enabled: this.yoloEnabled, requestId })
  } catch (error) {
    this.postMessage({ type: "yoloStatus", ok: true, enabled: this.yoloEnabled, requestId })
  }
}
// testagent_change end
```

设计要点：
- **extension 内存是事实源**：`yoloEnabled` 只在用户手动 toggle 时写入 → 重启 VS Code（extension host 重启）才重置；
- **后端双写**：让 CLI 进程侧的检查点（permission/llm/prompt/question）读到一致状态；
  同步失败只记日志、不阻塞开关（前端体验优先，webview 重挂载时可自愈）；
- **查询回退**：`this.yoloEnabled || serverEnabled` 只升不降——防止 extension 刚启动内存为 false
  时把后端已开启的状态误报为关闭。

### 4.4 消息类型 — `webview-ui/src/types/messages.ts`

```ts
// testagent_change start - YOLO 模式开关消息类型（全局开关，与 session 无关）
export interface YoloStatusMessage {
  type: "yoloStatus"
  ok: boolean
  enabled: boolean
  requestId: string
  error?: string
}
export interface RequestYoloToggleMessage {
  type: "requestYoloToggle"
  enabled: boolean
}
export interface RequestYoloStatusMessage {
  type: "requestYoloStatus"
  requestId: string
}
// testagent_change end
```

三者已分别注册进 `WebviewMessage` / `ExtensionMessage` union
（v2 修正：消息不再带 `sessionID` 字段，并清掉了一份重复声明）。

---

## 五、完整调用链路

```
用户点击 YOLO 开关（任意会话 / 无会话页面均可）
  │
  ├─ 开 ──▶ PromptInput: yolo.toggle(true)
  │          │ 乐观更新 UI（按钮变绿、tooltip 切换）
  │          ▼ postMessage(requestYoloToggle { enabled: true })
  │        KiloProvider.handleYoloToggle
  │          │ ① this.yoloEnabled = true          ← extension 内存事实源
  │          │ ② postMessage(yoloStatus { ok, enabled })  → useYolo 校正、解除 busy
  │          │ ③ PUT /testagent/yolo { enabled: true }
  │        TestagentHttpApi.yoloSet handler
  │          │
  │          ▼ Yolo.set(true)                     ← CLI 进程级布尔置位
  │          │   └─ GlobalBus.emit("testagent.yolo.enabled")
  │          ▼ 返回 { applied: true }
  │
  └─ 关 ──▶ 同上（enabled: false）

之后所有会话的每次 agent 轮次（与 sessionID 无关）：
  prompt.ts  组装 system prompt  ── Yolo.isEnabled()? ──▶ 追加 YOLO 约束段
  llm.ts     组装 tools 列表     ── Yolo.isEnabled()? ──▶ delete tools.question
  工具执行 → Permission.ask     ── Yolo.isEnabled()? ──▶ 直接 return（不评估规则/不挂起/不发事件）
  question 兜底 → Question.ask  ── Yolo.isEnabled()? ──▶ 自动答第一个选项返回
  模型臆造 question 调用 → AI SDK NoSuchToolError → tool-error → "Unknown tool" 回灌模型

状态恢复（webview 重挂载 / 切会话）：
  useYolo effect → postMessage(requestYoloStatus) → KiloProvider.handleYoloStatus
    → GET /testagent/yolo → extension 内存 || 后端 → postMessage(yoloStatus) → 校正 UI

生命周期：
  重启 VS Code（extension host + CLI 子进程都重启）→ 两侧内存复位 → 默认关闭
```

---

## 六、与 cline YOLO 的语义对照（验收）

| cline yolo 行为 | 本实现 | 状态 |
|---|---|---|
| 所有工具 autoApprove，跳过审批回调 | `Permission.ask` 入口短路直接放行 | ✅ 单测覆盖 |
| 绕过 deny（用户明确要求的语义） | 短路在规则评估**之前**，deny 同样绕过 | ✅ 单测覆盖（同一 deny 规则关闭时抛错/开启时放行） |
| `ask_question` 工具不注册 | `llm.ts` 过滤 `tools.question` | ✅ typecheck + 链路验证 |
| 模型强行调用 → `Unknown tool` 错误回退 | AI SDK `NoSuchToolError` → `tool-error` → processor 回灌 | ✅ AI SDK 源码验证 |
| 提示词声明"用户不在场、不可沟通" | `yolo-prompt.ts` SECTION 注入 system prompt | ✅ |
| skill 中"提问用户"的指令 → 被忽略、模型自主决策 | 同上三层防线 | ✅ |
| 连续错误熔断（yolo 下直接 stop） | 未实现（opencode 有独立 doom-loop 机制，语义不完全对应） | ⚠️ 见"已知限制" |
| cron 任务默认 yolo | 未实现（暂无对应场景） | ⚠️ |

**与 cline 的有意差异**：
1. cline 的 YOLO 是 per-run/per-agent-mode 的；本实现是**全局开关**（用户要求），
   所有会话统一生效，直到手动关闭或重启 VS Code；
2. 多了一层 `Question.ask` 自动答复兜底（cline 只有"工具不注册 + Unknown tool"）。

---

## 七、验证结果

全部验证均与干净基线（`git stash` 后同命令）对比，结论为**零新增错误/失败**：

| 检查项 | 基线 | 改动后 | 结论 |
|---|---|---|---|
| **YOLO 专项单测**（全局语义 6 用例） | — | **6 pass / 0 fail** | 核心行为全覆盖 |
| permission 回归（`test/permission/`，88 用例） | — | 88 pass / 0 fail | 无回归 |
| 后端 typecheck（tsgo） | 50 error | 50 error | 零新增，yolo 相关错误为零 |
| extension typecheck | 62 error | 62 error | 零新增 |
| webview typecheck | 预存 | 预存 | yolo 相关错误为零 |

### 验证中发现并修复的问题

**v1（session 级设计）阶段**：
1. `client.yolo` 不存在 → SDK 中 Yolo 是 Testagent 子资源，修正为 `client.testagent.yolo`；
2. GET 端点误用 `params`（生成 path 参数但 URL 无占位符）→ 改 `query` 传参并重新生成 SDK（v2 后该端点已无参数）；
3. 前端 `busy` 只在 3s 兜底 timer 才清除导致按钮假死 → 回包到达即解除。

**v2（全局开关）阶段——即用户报的"点击 yolo icon 没反应、tooltip 也不切换"**：
4. `toggle()` 里 `if (!currentSessionID()) return` → 无活动会话时静默无效；
5. 按钮 `disabled={!server.isConnected() || yolo.busy()}`，`connectionState` 初始 `"connecting"` 且 webview 重挂载后常不为 `"connected"` → 按钮被禁用；
   → 两者均随全局语义重构消除：切换不依赖 sessionID，`disabled` 只留 `busy()`。

---

## 八、改动文件清单

### 后端 `packages/testagent-core/packages/opencode/`

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/testagent/yolo.ts` | 新增 | YOLO 全局开关纯模块（`let enabled` + `set/isEnabled/reset` + GlobalBus 事件） |
| `src/testagent/yolo-prompt.ts` | 新增 | YOLO 系统提示词段 |
| `src/permission/index.ts` | 修改 | `ask()` 入口 YOLO 短路（`Yolo.isEnabled()`，testagent_change 标记） |
| `src/question/index.ts` | 修改 | `ask()` 入口 YOLO 自动答复兜底（标记） |
| `src/session/llm.ts` | 修改 | YOLO 下过滤 `tools.question`（标记） |
| `src/session/prompt.ts` | 修改 | YOLO 下追加系统提示词段（标记） |
| `src/server/routes/instance/httpapi/groups/testagent.ts` | 修改 | `yoloSet`/`yoloGet` endpoint + payload schema（无 sessionID） |
| `src/server/routes/instance/httpapi/handlers/testagent.ts` | 修改 | `yoloSet`/`yoloGet` handler |
| `test/testagent/yolo.test.ts` | 新增 | 6 个行为单测（全局语义） |
| `packages/sdk/openapi.json` | 生成 | SDK 再生成产物 |

### SDK `packages/sdk/js/`（`bun run script/generate.ts` 生成，勿手改）

| 文件 | 说明 |
|---|---|
| `src/v2/gen/sdk.gen.ts` | `Yolo.get/set` 客户端方法 + Testagent 注册（`set({ directory, enabled })`、`get({ directory })`） |
| `src/v2/gen/types.gen.ts` | `TestagentYoloSetPayload`（仅 `enabled`）等类型 |

### 前端 `packages/kilo-vscode/`

| 文件 | 说明 |
|---|---|
| `src/KiloProvider.ts` | `requestYoloToggle`/`requestYoloStatus` 消息处理；`yoloEnabled` 内存事实源 + 后端双写 + 查询只升不降 |
| `webview-ui/src/components/chat/PromptInput.tsx` | YOLO 开关按钮（`disabled={yolo.busy()}`） |
| `webview-ui/src/hooks/useYolo.ts` | 新增：全局状态 hook（乐观更新/回包校正/重挂载恢复/3s 兜底，无 sessionID 依赖） |
| `webview-ui/src/styles/prompt-input.css` | 开关样式（开启态绿色高亮） |
| `webview-ui/src/types/messages.ts` | 三个消息类型 + union 注册（无 sessionID） |

### 其他

| 文件 | 说明 |
|---|---|
| `packages/kilo-ui/src/lucide.ts` | 导出 `ShieldCheck` 图标 |
| `.changeset/add-yolo-mode.md` | changeset（minor，发布说明） |

---

## 九、已知限制与后续工作

1. **未实机点测**：未打包 VSIX 装入 Insiders 做 UI 实测（类型/单测层面已全绿）；
   打包命令：`bun run testagent-nodejs:vsix`（packages/kilo-vscode/）+ `code-insiders --install-extension`。
2. **状态不持久化**：两侧均为内存态（extension host + CLI 进程），VS Code 重启后复位——
   与用户要求一致；如需跨重启保留，可在 toggle 时落盘到用户 settings。
3. **同步失败不自愈**：`handleYoloToggle` 双写后端失败只记日志；
   若 CLI 进程恰好重启（server 侧复位为 false）而 extension 侧仍为 true，
   行为短暂不一致，直到下一次 toggle 或 reload window 查询自愈。
4. **无连续错误熔断**：cline yolo 下连续错误直接 stop；opencode 侧有独立的 doom-loop 机制，
   语义不对应，未组合。
5. **`reset()` 未接线**：`Yolo.reset()` 已提供但尚未挂到进程退出钩子
   （纯内存布尔，进程退出即消失，无泄漏风险，接线属可选）。
6. **预存问题未处理**（非本次引入，基线对比确认）：50 个后端 typecheck 错误、
   extension/webview 预存错误、knip/kilocode-change 失败（构建产物 `node.js.map` 含上游标记）。
