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
import { childID, inSpan } from "../../context/session-utils"
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

  // testagent_change - part 状态可能是进程崩溃前遗留的（被杀时 processor 来不及收尾），
  // 必须以子会话实时状态为准：子会话不忙时不显示"启动中"，也不给停止按钮
  const busy = createMemo(() => {
    const id = childSessionId()
    const status = id ? session.allStatusMap()[id]?.type : undefined
    return status === "busy" || status === "retry"
  })
  const running = createMemo(() => (props.status === "pending" || props.status === "running") && busy())

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

  // All tool parts from the child session — the compact summary list.
  // testagent_change - 按本次 task 调用的时间窗裁剪：同一个子会话可能被多次调用复用
  // （task_id 恢复），旧卡片不能镜像后续执行产生的工具项
  const childToolParts = createMemo(() => {
    const id = childSessionId()
    if (!id) return []
    return getSessionToolParts(data.store, id).filter((p) =>
      inSpan("time" in p.state ? p.state.time.start : undefined, props.time),
    )
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
  // testagent_change - 只有「本次调用在飞」才可停止：同一个子会话可能被多次调用复用，
  // 已结束的旧卡片不应再给出停止按钮（否则点任一张都会停掉同一个子会话）
  const stoppable = () => running()

  // testagent_change - 本次调用结束后子会话又被后续调用复用（task_id 恢复）。
  // 此时不能再提供“打开子任务”入口：那边展示的是子会话的最新状态（还在跑、还在计时），
  // 与这张已结束的卡片不是同一次运行
  const superseded = createMemo(() => {
    const id = childSessionId()
    const end = props.time?.end
    if (!id || !end) return false
    const msgs = (data.store.message as Record<string, SDKMessage[]> | undefined)?.[id] ?? []
    return msgs.some((m) => (m.time?.created ?? 0) > end)
  })

  const trigger = () => (
    <div data-slot="basic-tool-tool-info-structured">
      <div data-slot="basic-tool-tool-info-main">
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
      <Show when={childSessionId() && !superseded()}>
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
