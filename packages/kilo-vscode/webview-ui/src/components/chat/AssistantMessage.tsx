/**
 * AssistantMessage component
 * Renders all parts of an assistant message as a flat list — no context grouping.
 * Unlike the upstream AssistantParts, this renders each read/glob/grep/list tool
 * individually for maximum verbosity in the VS Code sidebar context.
 *
 * Active questions render inline via QuestionDock; permissions are in the bottom dock.
 */

import { Component, For, Show, createMemo } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Part, PART_MAPPING, ToolRegistry } from "@kilocode/kilo-ui/message-part"
import { BasicTool } from "@kilocode/kilo-ui/basic-tool"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import type {
  AssistantMessage as SDKAssistantMessage,
  Part as SDKPart,
  Message as SDKMessage,
  ToolPart,
} from "@kilocode/sdk/v2"
import { useData } from "@kilocode/kilo-ui/context/data"
import { useSession } from "../../context/session"
import { QuestionDock } from "./QuestionDock"
import { SuggestBar } from "./SuggestBar"

// Tools that the upstream message-part renderer suppresses (returns null for).
// We render these ourselves via ToolRegistry when they complete,
// so the user can see what the AI set up.
export const UPSTREAM_SUPPRESSED_TOOLS = new Set(["todowrite", "todoread"])

// testagent_change start - testflow tools bypass ToolPartDisplay entirely
// so they render without the McpTool card wrapper.
const TESTFLOW_TOOLS = new Set(["testflow-progress", "testflow-result"])

function checkTestflowLog(part: SDKPart): boolean {
  return part.type === "text" && !!(part as SDKPart & { testflow?: boolean }).testflow
}

function isRenderable(part: SDKPart): boolean {
  if (part.type === "tool") {
    const tool = (part as SDKPart & { tool: string }).tool
    const state = (part as SDKPart & { state: { status: string } }).state
    if (UPSTREAM_SUPPRESSED_TOOLS.has(tool)) {
      // Show todo parts only when completed (permissions are now in the dock)
      return state.status === "completed"
    }
    // Always render question tool parts — active ones get the inline QuestionDock
    return true
  }
  if (part.type === "text") return !!(part as SDKPart & { text: string }).text?.trim()
  if (part.type === "reasoning") return !!(part as SDKPart & { text: string }).text?.trim()
  return !!PART_MAPPING[part.type]
}
function matchToolRequest<T extends { tool?: { callID: string; messageID: string } }>(
  part: SDKPart,
  name: string,
  requests: T[],
): T | undefined {
  if (part.type !== "tool") return undefined
  const tp = part as unknown as ToolPart
  if (tp.tool !== name) return undefined
  return requests.find((r) => r.tool?.callID === tp.callID && r.tool?.messageID === tp.messageID)
}

interface AssistantMessageProps {
  message: SDKAssistantMessage
  showAssistantCopyPartID?: string | null
}

function TodoToolCard(props: { part: ToolPart }) {
  const render = ToolRegistry.render(props.part.tool)
  const state = props.part.state as any
  return (
    <Show when={render}>
      {(renderFn) => (
        <Dynamic
          component={renderFn()}
          input={state?.input ?? {}}
          metadata={state?.metadata ?? {}}
          tool={props.part.tool}
          output={state?.output}
          status={state?.status}
          defaultOpen
          reveal={false}
        />
      )}
    </Show>
  )
}

// testagent_change start - inline testflow tool renderers (bypasses ToolPartDisplay + ToolRegistry)
function TestflowToolCard(props: { part: ToolPart }) {
  const state = props.part.state as any
  const input = () => (state?.input ?? {}) as Record<string, any>
  const status = () => state?.status as string | undefined

  // testflow-result
  if (props.part.tool === "testflow-result") {
    return <TestflowResultCard input={input() as TestflowResultInput} output={String(state?.output ?? "")} />
  }

  // testflow-progress
  if (props.part.tool === "testflow-progress") {
    const progInput = () => input() as {
      taskName: string
      stages: {
        stage_id: string
        stage_name: string
        status: string
        execute_end_time: string | null
        status_icon: string
        status_text: string
      }[]
      completedCount: number
      totalCount: number
      percent: number
      nextHint: string
      exceptionHint: string | null
    }

    const statusIcon = (s: string) => {
      if (s === "completed") return "✓"
      if (s === "executing" || s === "awaiting_access") return "›"
      if (s === "skipped") return "⏭"
      if (s === "exception") return "✗"
      return "○"
    }

    const statusText = (s: string) => {
      if (s === "completed") return "完成"
      if (s === "executing" || s === "awaiting_access") return "进行中"
      if (s === "skipped") return "跳过"
      if (s === "exception") return "异常"
      return "待开始"
    }

    const fmtTime = (iso: string | null) => {
      if (!iso) return null
      const d = new Date(iso)
      const mm = (d.getMonth() + 1).toString().padStart(2, "0")
      const dd = d.getDate().toString().padStart(2, "0")
      const hh = d.getHours().toString().padStart(2, "0")
      const mi = d.getMinutes().toString().padStart(2, "0")
      return `${mm}-${dd} ${hh}:${mi}`
    }

    return (
      <div class="testflow-progress">
        <div class="testflow-progress-title">任务清单 [{progInput().taskName}]</div>
        <div class="testflow-progress-separator">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
        <For each={progInput().stages}>
          {(stage) => (
            <div class="testflow-progress-stage">
              <span class="testflow-progress-icon">{statusIcon(stage.status)}</span>
              <span class="testflow-progress-id">{stage.stage_id}</span>
              <span class="testflow-progress-name">{stage.stage_name}</span>
              <span class="testflow-progress-status">{statusText(stage.status)}</span>
              <Show when={stage.execute_end_time}>
                <span class="testflow-progress-time">{fmtTime(stage.execute_end_time)}</span>
              </Show>
            </div>
          )}
        </For>
        <div class="testflow-progress-separator">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
        <div class="testflow-progress-footer">
          <div class="testflow-progress-progress">
            进度: {progInput().completedCount}/{progInput().totalCount} ({progInput().percent}%)
          </div>
          <Show when={progInput().exceptionHint}>
            <div class="testflow-progress-exception">{progInput().exceptionHint}</div>
          </Show>
          <Show when={progInput().nextHint}>
            <div class="testflow-progress-next">
              <span>下一步：</span>
              <span class="testflow-progress-hint">{progInput().nextHint}</span>
            </div>
          </Show>
        </div>
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// testflow-result
// 一锤子命令（init/new/list/switch/validate）结果卡片
// ---------------------------------------------------------------------------

type TestflowResultInput = {
  kind: "init" | "new" | "list" | "switch" | "validate" | "error"
  [k: string]: unknown
}

function buildResultMarkdown(kind: string, payload: Record<string, unknown>): string {
  if (kind === "init") {
    const baseDir = String(payload.baseDir ?? "")
    const nextStep = String(payload.nextStep ?? "")
    const created = Array.isArray(payload.createdDirs) ? (payload.createdDirs as string[]) : []
    const tree = created.length
      ? created.map((line) => `  ${line}`).join("\n")
      : "  (无)"
    return [
      `📂 **基目录** \`${baseDir}\``,
      "",
      "**目录结构**",
      "```",
      tree,
      "```",
      "",
      `**下一步**: \`${nextStep}\``,
    ].join("\n")
  }
  if (kind === "new") {
    const taskName = String(payload.taskName ?? "")
    const taskDir = String(payload.taskDir ?? "")
    const created = Number(payload.created ?? 0)
    const existed = Number(payload.existed ?? 0)
    return [
      `📁 **任务** \`${taskName}\``,
      "",
      `**目录**: \`${taskDir}\``,
      "",
      `**新建**: ${created} 项 · **已存在跳过**: ${existed} 项`,
    ].join("\n")
  }
  if (kind === "list") {
    const tasks = Array.isArray(payload.tasks) ? (payload.tasks as Array<{ sdtTaskId: string; taskId: string | null }>) : []
    if (tasks.length === 0) return "_当前没有任务_"
    const lines = tasks.map((t, i) => {
      const id = t.taskId ? ` _(TMS: ${t.taskId})_` : ""
      return `${i + 1}. \`${t.sdtTaskId}\`${id}`
    })
    return `共 **${tasks.length}** 个任务：\n\n${lines.join("\n")}`
  }
  if (kind === "switch") {
    return `当前默认任务已切换为 \`${String(payload.current ?? "")}\``
  }
  if (kind === "validate") {
    const taskName = String(payload.taskName ?? "")
    const passed = Boolean(payload.passed)
    const configFile = payload.configFile ? String(payload.configFile) : ""
    const errors = Array.isArray(payload.errors) ? (payload.errors as string[]) : []
    if (passed) {
      return [
        `任务 \`${taskName}\` 的流程配置校验通过。`,
        configFile ? `\n**配置**: \`${configFile}\`` : "",
      ].join("")
    }
    return [
      `任务 \`${taskName}\` 的流程配置校验失败：`,
      "",
      errors.map((e) => `- ${e}`).join("\n"),
    ].join("\n")
  }
  // kind === "error"
  return `❌ **${String(payload.command ?? "命令")} 执行失败**\n\n\`\`\`\n${String(payload.error ?? "")}\n\`\`\``
}

function buildResultStatusClass(kind: string): string {
  if (kind === "error") return "testflow-result-error"
  if (kind === "validate") return "testflow-result-warning"
  return "testflow-result-success"
}

const TestflowResultCard: Component<{ input: TestflowResultInput; output: string }> = (props) => {
  const kind = () => props.input.kind
  const title = () => (() => {
    switch (kind()) {
      case "init": return "初始化 SDT 框架"
      case "new": return "创建测试任务"
      case "list": return "任务列表"
      case "switch": return "切换默认任务"
      case "validate": return "校验流程配置"
      case "error": return "命令执行失败"
      default: return "命令结果"
    }
  })()
  const body = () => buildResultMarkdown(kind(), props.input as Record<string, unknown>)

  return (
    <BasicTool
      icon="mcp"
      status="completed"
      defaultOpen={true}
      trigger={{
        title: title(),
        titleClass: `testflow-result-title ${buildResultStatusClass(kind())}`,
        subtitle: "该命令操作不涉及上下文对话",
        subtitleClass: "testflow-result-subtitle",
      }}
    >
      <div data-component="tool-output" data-scrollable class="testflow-result-body">
        <Markdown text={body()} />
      </div>
    </BasicTool>
  )
}

// testagent_change end

export const AssistantMessage: Component<AssistantMessageProps> = (props) => {
  const data = useData()
  const session = useSession()

  const parts = createMemo(() => {
    const stored = data.store.part?.[props.message.id]
    if (!stored) return []
    return (stored as SDKPart[]).filter((part) => isRenderable(part))
  })

  return (
    <>
      <For each={parts()}>
        {(part) => {
          // testagent_change start - testflow tools bypass ToolPartDisplay entirely
          const isTestflow =
            part.type === "tool" && TESTFLOW_TOOLS.has((part as SDKPart & { tool: string }).tool)
          const isTestflowLog = checkTestflowLog(part)
          // testagent_change end

          // Upstream PART_MAPPING["tool"] returns null for todowrite/todoread,
          // so we detect them here and render via ToolRegistry directly.
          const isUpstreamSuppressed =
            part.type === "tool" && UPSTREAM_SUPPRESSED_TOOLS.has((part as SDKPart & { tool: string }).tool)

          // Active question tool parts render the interactive QuestionDock inline
          const activeQuestion = createMemo(() => matchToolRequest(part, "question", session.questions()))

          // Active suggestion tool parts render the interactive SuggestBar inline
          const activeSuggestion = createMemo(() => matchToolRequest(part, "suggest", session.suggestions()))

          return (
            <Show when={isTestflow || isTestflowLog || isUpstreamSuppressed || activeQuestion() || activeSuggestion() || PART_MAPPING[part.type]}>
              {/* testagent_change start - testflow tools render outside tool-part-wrapper */}
              <Show when={isTestflowLog} fallback={
                <Show when={isTestflow} fallback={
                  <div data-component="tool-part-wrapper" data-part-type={part.type}>
                    <Show
                      when={activeQuestion()}
                      fallback={
                        <Show
                          when={activeSuggestion()}
                          fallback={
                            <Show
                              when={isUpstreamSuppressed}
                              fallback={
                                <Part
                                  part={part}
                                  message={props.message as SDKMessage}
                                  showAssistantCopyPartID={props.showAssistantCopyPartID}
                                  animate={
                                    part.type === "tool" &&
                                    ((part as unknown as ToolPart).state?.status === "pending" ||
                                      (part as unknown as ToolPart).state?.status === "running")
                                  }
                                />
                              }
                            >
                              <TodoToolCard part={part as unknown as ToolPart} />
                            </Show>
                          }
                        >
                          {(req) => <SuggestBar request={req()} />}
                        </Show>
                      }
                    >
                      {(req) => <QuestionDock request={req()} />}
                    </Show>
                  </div>
                }>
                  <TestflowToolCard part={part as unknown as ToolPart} />
                </Show>
              }>
                <pre class="testflow-log">{(part as SDKPart & { text: string }).text}</pre>
              </Show>
              {/* testagent_change end */}
            </Show>
          )
        }}
      </For>
    </>
  )
}
