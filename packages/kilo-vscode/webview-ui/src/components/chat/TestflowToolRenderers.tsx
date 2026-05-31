// testagent_change - new file
/**
 * TestflowToolRenderers
 *
 * Registers three custom tool renderers into ToolRegistry so the standard
 * AssistantMessage / Part pipeline can render testflow events natively:
 *
 *   testflow-step     - a single execution step (running / completed / error)
 *   testflow-question - an interactive question waiting for user input
 *   testflow-agent    - an AI agent sub-execution (running / completed)
 *
 * Call registerTestflowToolRenderers() once at app startup (after kilo-ui
 * tool registrations have run).
 */

import { Component, For, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { ToolRegistry, type ToolProps } from "@kilocode/kilo-ui/message-part"
import { useVSCode } from "../../context/vscode"

// ---------------------------------------------------------------------------
// testflow-step
// ---------------------------------------------------------------------------

const TestflowStepTool: Component<ToolProps> = (props) => {
  const title = () => (props.input as any).title as string
  const status = () => props.status ?? "running"

  return (
    <div class="testflow-tool-step" data-status={status()}>
      <Show
        when={status() === "running"}
        fallback={
          <Show
            when={status() === "completed"}
            fallback={<Icon name="circle-x" size="small" />}
          >
            <Icon name="circle-check" size="small" />
          </Show>
        }
      >
        <Spinner class="chat-spinner-small" />
      </Show>
      <span class="testflow-tool-step-title">{title()}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// testflow-question
// ---------------------------------------------------------------------------

const TestflowQuestionTool: Component<ToolProps> = (props) => {
  const vscode = useVSCode()
  const input = () => props.input as {
    id: string
    header: string
    question: string
    options: { label: string; description: string }[]
    multiple?: boolean
  }
  const pending = () => props.status === "pending"

  const reply = (label: string) => {
    vscode.postMessage({ type: "testflow.questionReply", id: input().id, answers: [label] })
  }

  const reject = () => {
    vscode.postMessage({ type: "testflow.questionReject", id: input().id })
  }

  return (
    <div class="testflow-tool-question" data-pending={pending()}>
      <div class="testflow-tool-question-header">
        <Icon name="help" size="small" />
        <span>{input().header || input().question}</span>
      </div>
      <Show when={pending()}>
        <Show when={input().question && input().question !== input().header}>
          <div class="testflow-tool-question-body">{input().question}</div>
        </Show>
        <div class="testflow-tool-question-options">
          <For each={input().options}>
            {(opt) => (
              <Button variant="secondary" size="small" onClick={() => reply(opt.label)}>
                {opt.label}
              </Button>
            )}
          </For>
        </div>
        <div class="testflow-tool-question-actions">
          <Button variant="ghost" size="small" onClick={reject}>
            Cancel
          </Button>
        </div>
      </Show>
      <Show when={!pending()}>
        <span class="testflow-tool-question-done">
          <Icon name="check" size="small" /> Answered
        </span>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// testflow-agent
// ---------------------------------------------------------------------------

const TestflowAgentTool: Component<ToolProps> = (props) => {
  const skill = () => (props.input as any).skill as string | undefined
  const status = () => props.status ?? "running"

  return (
    <div class="testflow-tool-agent" data-status={status()}>
      <Show
        when={status() === "running"}
        fallback={<Icon name="circle-check" size="small" />}
      >
        <Spinner class="chat-spinner-small" />
      </Show>
      <span class="testflow-tool-agent-label">
        {skill() ? `AI Agent: ${skill()}` : "AI Agent"}
        {status() === "running" ? "..." : ""}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// testflow-progress
// ---------------------------------------------------------------------------

const TestflowProgressTool: Component<ToolProps> = (props) => {
  const input = () => props.input as {
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
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed": return "✓"
      case "executing":
      case "awaiting_access": return "›"
      case "skipped": return "⏭"
      case "exception": return "✗"
      default: return "○"
    }
  }

  const statusText = (status: string) => {
    switch (status) {
      case "completed": return "完成"
      case "executing":
      case "awaiting_access": return "进行中"
      case "skipped": return "跳过"
      case "exception": return "异常"
      default: return "待开始"
    }
  }

  return (
    <div class="testflow-progress">
      <div class="testflow-progress-title">任务清单 [{input().taskName}]</div>
      <div class="testflow-progress-separator">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
      <For each={input().stages}>
        {(stage) => (
          <div class="testflow-progress-stage">
            <span class="testflow-progress-icon">{statusIcon(stage.status)}</span>
            <span class="testflow-progress-id">{stage.stage_id}</span>
            <span class="testflow-progress-name">{stage.stage_name}</span>
            <span class="testflow-progress-status">{statusText(stage.status)}</span>
            <Show when={stage.execute_end_time}>
              <span class="testflow-progress-time">
                {new Date(stage.execute_end_time!).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </Show>
          </div>
        )}
      </For>
      <div class="testflow-progress-separator">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
      <div class="testflow-progress-footer">
        进度: {input().completedCount}/{input().totalCount} ({input().percent}%)
        <Show when={input().nextHint}>
          <span class="testflow-progress-hint">  |  {input().nextHint}</span>
        </Show>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false

export function registerTestflowToolRenderers() {
  if (registered) return
  registered = true

  ToolRegistry.register({ name: "testflow-step", render: TestflowStepTool })
  ToolRegistry.register({ name: "testflow-question", render: TestflowQuestionTool })
  ToolRegistry.register({ name: "testflow-agent", render: TestflowAgentTool })
  ToolRegistry.register({ name: "testflow-progress", render: TestflowProgressTool })
}
