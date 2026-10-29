/**
 * TaskToolExpanded component
 * Registers a custom "task" tool renderer that matches the v1.0.25 layout:
 * a BasicTool open by default with a compact scrollable list of child tool calls,
 * each shown as: icon + title + subtitle.
 *
 * Call registerExpandedTaskTool() once at app startup to activate.
 */

import { Component, createEffect, createMemo, For, Show } from "solid-js"
import { ToolRegistry, ToolProps, getToolInfo } from "@kilocode/kilo-ui/message-part"
import { BasicTool } from "@kilocode/kilo-ui/basic-tool"
import { Icon } from "@kilocode/kilo-ui/icon"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useData } from "@kilocode/kilo-ui/context/data"
import { useLanguage } from "../../context/language"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import { createAutoScroll } from "@kilocode/kilo-ui/hooks"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { childID } from "../../context/session-utils"
import type { ToolPart, Message as SDKMessage } from "@kilocode/sdk/v2"

/** Collect all tool parts from all assistant messages in a given session. */
function getSessionToolParts(store: ReturnType<typeof useData>["store"], sessionId: string): ToolPart[] {
  const messages = (store.message?.[sessionId] as SDKMessage[] | undefined)?.filter((m) => m.role === "assistant")
  if (!messages) return []
  const parts: ToolPart[] = []
  for (const m of messages) {
    const msgParts = store.part?.[m.id]
    if (msgParts) {
      for (const p of msgParts) {
        if (p && p.type === "tool") parts.push(p as ToolPart)
      }
    }
  }
  return parts
}

const TaskToolRenderer: Component<ToolProps> = (props) => {
  const data = useData()
  const i18n = useI18n()
  const language = useLanguage()
  const session = useSession()
  const vscode = useVSCode()

  const childSessionId = () =>
    childID({
      type: "tool",
      tool: props.tool,
      metadata: props.partMetadata as { sessionId?: string } | undefined,
      state: { metadata: props.metadata as { sessionId?: string } },
    })

  const running = createMemo(() => props.status === "pending" || props.status === "running")
  const busy = createMemo(() => {
    const id = childSessionId()
    return id ? session.allStatusMap()[id]?.type === "busy" : false
  })

  // testagent_change start - sub-agent status indicator
  // 子 agent 窗口上的状态点：运行中(脉冲) / 已结束 / 失败 / 等待。
  // 信号源：父会话 task part 状态(running) ∪ 子会话实时 SSE 状态(busy)。
  // handleSubtask 在 prompt.ts 里把 part 从 running 翻到 completed/error，
  // 两个信号任一为真即视为仍在运行，避免 SSE 抖动导致早翻完成态(误判已结束)。
  const dotState = createMemo<"running" | "completed" | "idle" | "error">(() => {
    if (props.status === "error") return "error"
    if (running() || busy()) return "running"
    if (props.status === "completed") return "completed"
    return "idle"
  })
  const dotLabel = createMemo(() => {
    switch (dotState()) {
      case "running":
        return language.t("session.messages.subagent.running")
      case "completed":
        return language.t("session.messages.subagent.ended")
      case "error":
        return language.t("session.messages.subagent.failed")
      default:
        return language.t("session.messages.subagent.pending")
    }
  })
  // testagent_change end - sub-agent status indicator

  // Warm child session data immediately so completed task tools already have
  // their compact child tool list available when the user expands them.
  createEffect(() => {
    const id = childSessionId()
    if (!id) return
    session.syncSession(id)
  })

  const title = createMemo(() => i18n.t("ui.tool.agent", { type: props.input.subagent_type || props.tool }))

  const description = createMemo(() => {
    const val = props.input.description
    return typeof val === "string" ? val : undefined
  })

  // Model info from the child session's first assistant message
  const childModel = createMemo(() => {
    const id = childSessionId()
    if (!id) return undefined
    const msgs = (data.store.message as Record<string, SDKMessage[]> | undefined)?.[id]
    if (!msgs) return undefined
    const first = msgs.find((m) => m.role === "assistant")
    if (!first?.modelID) return undefined
    const pid = first.providerID ?? ""
    const short = pid.replace(/^sensenova\//, "")
    return short ? `${short}/${first.modelID}` : first.modelID
  })

  // All tool parts from the child session — the compact summary list
  const childToolParts = createMemo(() => {
    const id = childSessionId()
    if (!id) return []
    return getSessionToolParts(data.store, id)
  })

  const autoScroll = createAutoScroll({
    working: running,
  })

  const openInTab = (e: MouseEvent) => {
    e.stopPropagation()
    const id = childSessionId()
    if (!id) return
    vscode.postMessage({ type: "openSubAgentViewer", sessionID: id, title: description() })
  }

  // testagent_change - 停止这个 subagent 及其启动的子会话；父会话继续运行
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    const id = childSessionId()
    if (!id) return
    session.abort(id, "tree")
  }
  const stoppable = () => !!childSessionId() && (running() || busy())

  const trigger = () => (
    <div data-slot="basic-tool-tool-info-structured">
      <div data-slot="basic-tool-tool-info-main">
        {/* testagent_change start - sub-agent status indicator dot */}
        <Tooltip value={dotLabel()} placement="top">
          <span
            data-component="task-tool-status-dot"
            data-state={dotState()}
            role="img"
            aria-label={dotLabel()}
          />
        </Tooltip>
        {/* testagent_change end - sub-agent status indicator dot */}
        <span data-slot="basic-tool-tool-title" class="capitalize">
          {title()}
        </span>
        <Show when={description() || childToolParts().length > 0}>
          <span data-slot="basic-tool-tool-subtitle">
            {description()}
            <Show when={childToolParts().length > 0}>
              {description() ? " " : ""}({childToolParts().length})
            </Show>
            <Show when={childModel()}>
              <span style={{ "margin-left": "8px", opacity: 0.55, "font-size": "11px" }}>
                {childModel()}
              </span>
            </Show>
          </span>
        </Show>
      </div>
      {/* testagent_change start - sub-agent stop functionality */}
      <Show when={stoppable()}>
        <Tooltip value={language.t("prompt.action.stop")} placement="top">
          <IconButton
            icon="stop"
            size="small"
            variant="ghost"
            data-slot="task-tool-stop"
            aria-label={language.t("prompt.action.stop")}
            onClick={stop}
          />
        </Tooltip>
      </Show>
      {/* testagent_change end */}
      <Show when={childSessionId()}>
        <IconButton
          icon="square-arrow-top-right"
          size="small"
          variant="ghost"
          aria-label="Open sub-agent in tab"
          onClick={openInTab}
        />
      </Show>
    </div>
  )

  return (
    <div data-component="tool-part-wrapper">
      <BasicTool icon="task" status={props.status} trigger={trigger()} defaultOpen>
        <div ref={autoScroll.scrollRef} onScroll={autoScroll.handleScroll} data-component="tool-output" data-scrollable>
          <div ref={autoScroll.contentRef} data-component="task-tools">
            <Show when={running() && childToolParts().length === 0}>
              <div data-slot="task-tool-item" data-state="starting">
                <span data-slot="task-tool-title">{language.t("session.messages.taskStarting")}</span>
              </div>
            </Show>
            <For each={childToolParts()}>
              {(item) => {
                const info = createMemo(() => getToolInfo(item.tool, item.state?.input))
                const subtitle = createMemo(() => {
                  if (info().subtitle) return info().subtitle
                  const state = item.state as { status: string; title?: string }
                  if (state.status === "completed" || state.status === "running") {
                    return state.title
                  }
                  return undefined
                })
                return (
                  <div data-slot="task-tool-item">
                    <Icon name={info().icon} size="small" />
                    <span data-slot="task-tool-title">{info().title}</span>
                    <Show when={subtitle()}>
                      <span data-slot="task-tool-subtitle">{subtitle()}</span>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
      </BasicTool>
    </div>
  )
}

/**
 * Override the upstream "task" tool registration with the v1.0.25-style renderer.
 * Must be called once at app startup.
 */
export function registerExpandedTaskTool() {
  ToolRegistry.register({
    name: "task",
    render: TaskToolRenderer,
  })
}
