/**
 * TaskHeader component
 * Sticky header above the chat messages showing session title、
 * cost, context usage, and a compact button.
 * Also shows todo progress when the session has todos.
 *
 * When expanded, shows the task timeline (colored bars representing
 * session activity) and a context window progress bar.
 */

import { Component, For, Show, createMemo, createSignal, onMount, onCleanup } from "solid-js"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { useSession } from "../../context/session"
import { collapseCostBreakdown } from "../../context/session-utils"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { TaskTimeline } from "./TaskTimeline"
import { ContextProgress } from "./ContextProgress"
import type { TodoItem, ExtensionMessage } from "../../types/messages"

interface TaskHeaderProps {
  readonly?: boolean
}

export const TaskHeader: Component<TaskHeaderProps> = (props) => {
  const session = useSession()
  const language = useLanguage()

  const title = createMemo(() => session.currentSession()?.title ?? language.t("command.session.new"))
  const hasMessages = createMemo(() => session.messages().length > 0)
  const busy = createMemo(() => session.status() === "busy")
  const canCompact = createMemo(() => !busy() && hasMessages() && !!session.selected())
  const stop = () => session.abort()

  // testagent_change start - export conversation to markdown
  const exportConversation = () => {
    const messages = session.messages()
    const sessionTitle = title()

    if (messages.length === 0) return

    let md = `# ${sessionTitle}\n\n`
    md += `导出时间: ${new Date().toLocaleString("zh-CN")}\n\n`
    md += `---\n\n`

    for (const msg of messages) {
      const role = msg.role === "user" ? "👤 用户" : "🤖 助手"
      const ts = msg.createdAt ? new Date(msg.createdAt).toLocaleString("zh-CN") : ""

      md += `## ${role}\n`
      if (ts) md += `*${ts}*\n\n`
      if (msg.content) md += `${msg.content}\n\n`

      for (const p of session.getParts(msg.id)) {
        if (p.type === "text") {
          md += `${p.text}\n\n`
        } else if (p.type === "file") {
          md += `📎 文件: ${p.filename || "附件"} (${p.mime})\n\n`
        } else if (p.type === "tool") {
          md += `🔧 工具调用: ${p.tool}\n`
          if (p.state.status === "completed") md += "```\n" + p.state.output + "\n```\n\n"
        } else if (p.type === "reasoning") {
          md += `💭 推理过程:\n${p.text}\n\n`
        }
      }

      if (msg.tokens) {
        md += `*Token 使用: 输入 ${msg.tokens.input}, 输出 ${msg.tokens.output}`
        if (msg.tokens.reasoning) md += `, 推理 ${msg.tokens.reasoning}`
        md += `*\n\n`
      }

      md += `---\n\n`
    }

    vscode.postMessage({ type: "exportConversation", markdown: md, title: sessionTitle })
  }
  // testagent_change end

  const fmt = (n: number) => new Intl.NumberFormat(language.locale(), { style: "currency", currency: "USD" }).format(n)

  const breakdown = () => session.costBreakdown()

  const cost = createMemo(() => {
    const total = breakdown().reduce((sum, e) => sum + e.cost, 0)
    if (total === 0) return undefined
    return fmt(total)
  })

  const costTooltip = createMemo(() => {
    const items = breakdown()
    if (items.length <= 1) return <span>{language.t("context.usage.sessionCost")}</span>
    const collapsed = collapseCostBreakdown(items, (n) =>
      language.t("context.usage.olderSessions", { count: String(n) }),
    )
    return (
      <div style={{ "text-align": "left", "white-space": "nowrap" }}>
        <For each={collapsed}>{(e) => <div>{`${e.label}: ${fmt(e.cost)}`}</div>}</For>
      </div>
    )
  })

  const context = createMemo(() => {
    const usage = session.contextUsage()
    if (!usage) return undefined
    const tokens = usage.tokens.toLocaleString(language.locale())
    const pct = usage.percentage !== null ? `${usage.percentage}%` : undefined
    return { tokens, pct }
  })

  // Token breakdown from the last assistant message — only return if at least one value is > 0
  const tokens = createMemo(() => {
    const msgs = session.messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role !== "assistant" || !m.tokens) continue
      const tk = m.tokens
      const has = tk.input > 0 || tk.output > 0 || (tk.cache?.write ?? 0) > 0 || (tk.cache?.read ?? 0) > 0
      if (has) return tk
    }
    return undefined
  })

  const fmtNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  const vscode = useVSCode()
  const [expanded, setExpanded] = createSignal(true)

  // Read initial value from VS Code settings
  onMount(() => vscode.postMessage({ type: "requestTimelineSetting" }))
  const handler = (e: MessageEvent<ExtensionMessage>) => {
    if (e.data.type === "timelineSettingLoaded") setExpanded(e.data.visible)
  }
  window.addEventListener("message", handler)
  onCleanup(() => window.removeEventListener("message", handler))

  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    vscode.postMessage({ type: "updateSetting", key: "showTaskTimeline", value: next })
  }

  const todos = createMemo(() => session.todos())
  const hasTodos = createMemo(() => todos().length > 0)
  const doneCount = createMemo(() => todos().filter((t: TodoItem) => t.status === "completed").length)
  const totalCount = createMemo(() => todos().length)
  const allDone = createMemo(() => doneCount() === totalCount() && totalCount() > 0)

  const todoSummary = createMemo(() => {
    const done = doneCount()
    const total = totalCount()
    if (total === 0) return ""
    if (done === total) return language.t("task.todos.allDone", { count: String(total) })
    return language.t("task.todos.progress", { done: String(done), total: String(total) })
  })

  const [todosOpen, setTodosOpen] = createSignal(false)

  return (
    <Show when={hasMessages()}>
      <div data-component="task-header">
        <div data-slot="task-header-title" title={title()}>
          <svg class="testagent-avatar-inline" viewBox="-4 -4 32 32" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="th-rg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#4fc3f7" />
                <stop offset="50%" stop-color="#2979ff" />
                <stop offset="100%" stop-color="#69f0ae" />
              </linearGradient>
            </defs>
            <circle cx="12" cy="12" r="12" fill="#e8f4ff" />
            <circle cx="12" cy="12" r="12.75" fill="none" stroke="url(#th-rg)" stroke-width="1.5" />
            <ellipse class="th-blink" cx="8" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
            <ellipse class="th-blink" cx="16" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
          </svg>
          {title()}
        </div>

        <div data-slot="task-header-stats">
          <Show when={cost()}>
            {(c) => (
              <Tooltip value={costTooltip()} placement="bottom">
                <span>{c()}</span>
              </Tooltip>
            )}
          </Show>
          <Show when={context()}>
            {(ctx) => (
              <Tooltip
                value={ctx().pct ? `已使用 ${ctx().tokens} tokens（约占上下文 ${ctx().pct}）` : `${ctx().tokens}tokens`}
                placement="bottom"
              >
                <Show when={ctx().pct} fallback={<span>{ctx().tokens}</span>}>
                  {(pct) => (
                    <span
                      class="task-header-context-ring"
                      style={{
                        background: `conic-gradient(var(--vscode-foreground) ${pct()}, color-mix(in srgb, var(--vscode-foreground) 18%, transparent) 0)`,
                      }}
                      aria-label={`上下文已使用 ${pct()}`}
                    ></span>
                  )}
                </Show>
              </Tooltip>
            )}
          </Show>
          {/* testagent_change start - export conversation button */}
          <Show when={hasMessages() && !busy()}>
            <Tooltip value="导出对话" placement="bottom">
              <IconButton
                icon="download"
                size="small"
                variant="ghost"
                onClick={exportConversation}
                aria-label="导出对话"
              />
            </Tooltip>
          </Show>
          {/* testagent_change end */}
          <Show when={props.readonly && busy()}>
            <Tooltip value={language.t("prompt.action.stop")} placement="bottom">
              <IconButton
                icon="stop"
                size="small"
                variant="ghost"
                onClick={stop}
                aria-label={language.t("prompt.action.stop")}
              />
            </Tooltip>
          </Show>
          <Show when={!props.readonly}>
            <Tooltip value={language.t("command.session.compact")} placement="bottom">
              <IconButton
                icon="compress"
                size="small"
                variant="ghost"
                disabled={!canCompact()}
                onClick={() => session.compact()}
                aria-label={language.t("command.session.compact")}
              />
            </Tooltip>
          </Show>
          <Show when={hasMessages()}>
            <button
              data-slot="task-header-expand"
              onClick={toggle}
              aria-expanded={expanded()}
              aria-label="Toggle timeline"
            >
              <Icon name="chevron-down" size="small" style={expanded() ? { transform: "rotate(180deg)" } : undefined} />
            </button>
          </Show>
        </div>
      </div>
      {/* Expanded graph section: timeline + context bar + token breakdown */}
      <Show when={expanded() && session.messages().some((m) => m.role === "assistant")}>
        <div data-component="task-header-graph">
          <TaskTimeline />
          <div data-slot="task-header-graph-row">
            <ContextProgress />
          </div>
          <Show when={tokens()}>
            {(tk) => (
              <div class="task-header-tokens">
                <span class="task-header-tokens-label">Tokens</span>
                <Show when={tk().input > 0}>
                  <Tooltip value="包含内容：用户的问题/指令、系统提示词（system prompt）、对话历史、上下文信息（如文件内容、代码片段）、工具定义和文档">
                    <span class="task-header-tokens-value">
                      <Icon name="arrow-up" size="small" />
                      输入:{fmtNum(tk().input)}
                    </span>
                  </Tooltip>
                </Show>
                <Show when={tk().output > 0}>
                  <Tooltip value="包含内容：AI 的回复文本、生成的代码、工具调用（function calls）、推理过程">
                    <span class="task-header-tokens-value">
                      <Icon name="arrow-down-to-line" size="small" />
                      输出:{fmtNum(tk().output)}
                    </span>
                  </Tooltip>
                </Show>
                <Show when={tk().cache?.write && tk().cache!.write > 0}>
                  <span class="task-header-tokens-value">
                    <Icon name="arrow-up" size="small" />
                    写入缓存: {fmtNum(tk().cache!.write)}
                  </span>
                </Show>
                <Show when={tk().cache?.read && tk().cache!.read > 0}>
                  <span class="task-header-tokens-value">
                    <Icon name="arrow-down-to-line" size="small" />
                    读取缓存: {fmtNum(tk().cache!.read)}
                  </span>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={hasTodos()}>
        <div data-component="task-header-todos">
          <button
            data-slot="task-header-todos-trigger"
            onClick={() => setTodosOpen((v) => !v)}
            aria-expanded={todosOpen()}
          >
            <Icon name="checklist" size="small" />
            <span data-slot="task-header-todos-summary" data-all-done={allDone() ? "" : undefined}>
              {todoSummary()}
            </span>
            <Icon
              name="chevron-down"
              size="small"
              data-slot="task-header-todos-arrow"
              data-open={todosOpen() ? "" : undefined}
            />
          </button>
          <Show when={todosOpen()}>
            <div data-slot="task-header-todos-list">
              <For each={todos()}>
                {(todo: TodoItem) => (
                  <Checkbox readOnly checked={todo.status === "completed"}>
                    <span
                      data-slot="task-header-todo-content"
                      data-completed={todo.status === "completed" ? "" : undefined}
                    >
                      {todo.content}
                    </span>
                  </Checkbox>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  )
}
