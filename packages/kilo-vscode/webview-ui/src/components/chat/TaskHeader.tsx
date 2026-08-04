/**
 * TaskHeader component
 * Sticky header above the chat messages showing session title、
 * cost, context usage, and a compact button.
 * Also shows todo progress when the session has todos.
 *
 * When expanded, shows the task timeline (colored bars representing
 * session activity) and a context window progress bar.
 */

import { Component, For, Show, createMemo, createSignal, createEffect, onMount, onCleanup } from "solid-js"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { useSession } from "../../context/session"
import { collapseCostBreakdown, buildTimingSegments, fmtDuration } from "../../context/session-utils"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { TaskTimeline } from "./TaskTimeline"
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
  const stop = () => session.abort()



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

  const tokens = createMemo(() => {
    const tk = session.familyTokens()
    if (!tk) return undefined
    const has = tk.input > 0 || tk.output > 0 || tk.cache.read > 0 || tk.cache.write > 0
    if (has) return tk
    return undefined
  })

  const timing = createMemo(() => session.familyTiming())

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

    // 没有消息也没有数据时隐藏
    if (msgs.length === 0 && !t) return undefined

    // 空闲时直接返回静态数据
    if (isIdle && t) return t

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
      permissionWait: t?.permissionWait ?? 0,
      questionWait: t?.questionWait ?? 0,
      toolBreakdown: t?.toolBreakdown,
    }
  })

  const fmtNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  const vscode = useVSCode()
  const [expanded, setExpanded] = createSignal(true)
  const [timingOpen, setTimingOpen] = createSignal(true)

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
  const [copied, setCopied] = createSignal(false)

  const copySid = (sid: string) => {
    navigator.clipboard.writeText(sid)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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
          <Show when={hasMessages() && session.currentSessionID()}>
            <Tooltip
              value={copied() ? "已复制" : session.currentSessionID() ?? ""}
              placement="bottom"
            >
              <button
                data-slot="task-header-sessionid"
                onClick={() => {
                  const sid = session.currentSessionID()
                  if (sid) copySid(sid)
                }}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--vscode-descriptionForeground)",
                  "font-size": "11px",
                  padding: "0 4px",
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "2px",
                }}
              >
                {(session.currentSessionID() ?? "").slice(0, 20)}...
                <Icon name={copied() ? "check" : "copy"} size="small" />
              </button>
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
          <Show when={tokens()}>
            {(tk) => (
              <div class="task-header-tokens">
                <span class="task-header-tokens-label" style={{ "margin-right": '10px' }}>任务累计消耗tokens</span>
                <Show when={tk().input > 0}>
                  <Tooltip
                    value={
                      <Show when={tk().breakdown} fallback="会话全部turn累计的输入tokens">
                        {(br) => (
                          <div style={{ "text-align": "left", "white-space": "nowrap" }}>
                            <div>系统提示词: {fmtNum(br().system)}</div>
                            <div>对话历史:   {fmtNum(br().messages)}</div>
                            <div>工具定义:   {fmtNum(br().tools)}</div>
                            <hr style={{ margin: "2px 0", border: "none", "border-top": "1px solid currentColor", opacity: 0.3 }} />
                            <div>合计:       {fmtNum(tk().input)}</div>
                          </div>
                        )}
                      </Show>
                    }
                    placement="bottom"
                  >
                    <span class="task-header-tokens-value">
                      <Icon name="arrow-up" size="small" />
                      输入:{fmtNum(tk().input)}
                    </span>
                  </Tooltip>
                </Show>
                <Show when={tk().output > 0}>
                  <Tooltip value="会话全部turn累计的输出tokens，包含：AI 的回复文本、生成的代码、工具调用（function calls）、推理过程">
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
                <span style={{ "margin-left": "4px", opacity: 0.5 }}>|</span>
                <span class="task-header-tokens-value" style={{ "font-weight": 600 }}>
                  总计: {fmtNum(tk().total ?? (tk().input + tk().output + (tk().cache?.read ?? 0) + (tk().cache?.write ?? 0)))}
                </span>
                <Show when={liveTiming()}>
                  <button
                    data-slot="task-header-expand"
                    aria-expanded={timingOpen()}
                    aria-controls="task-header-timing"
                    title={timingOpen() ? "收起累计执行耗时统计" : "展开累计执行耗时统计"}
                    onClick={() => setTimingOpen((open) => !open)}
                  >
                    {timingOpen() ? "▲" : "▼"}
                  </button>
                </Show>
              </div>
            )}
          </Show>
          <Show when={timingOpen() ? liveTiming() : undefined}>
            {(t) => {
              const segments = () => buildTimingSegments(t())
              const pct = (v: number) => t().total > 0 ? `(${((v / t().total) * 100).toFixed(1)}%)` : ""
              return (
                <div id="task-header-timing" class="task-header-tokens" style={{ "margin-top": "6px", "line-height": "1.4" }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "4px", "flex-wrap": "wrap" }}>
                    <span class="task-header-tokens-label" style={{ "margin-right": '10px' }}>累计执行耗时统计</span>
                    <For each={segments()}>
                      {(seg, index) => {
                        const isTool = seg.key === "tool"
                        const breakdown = t().toolBreakdown
                        const toolEntries = (() => {
                          if (!isTool || !breakdown) return []
                          return Object.entries(breakdown).sort((a, b) => b[1] - a[1])
                        })()
                        return (
                          <>
                            {index() !== 0 && <span style={{ opacity: 0.4 }}>|</span>}
                            <Show when={isTool && toolEntries.length > 0} fallback={
                              <span style={{ color: seg.color, "font-size": "11px" }}>
                                {seg.label}: {fmtDuration(seg.duration)}
                              </span>
                            }>
                              <Tooltip value={
                                <div style={{ "text-align": "left", "white-space": "nowrap" }}>
                                  <For each={toolEntries}>
                                    {(entry) => <div>{entry[0]}: {fmtDuration(entry[1])}</div>}
                                  </For>
                                </div>
                              } placement="bottom">
                                <span style={{ color: seg.color, "font-size": "11px" }}>
                                  {seg.label}: {fmtDuration(seg.duration)}
                                </span>
                              </Tooltip>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                    <span style={{ opacity: 0.4 }}>|</span>
                    <Tooltip
                      contentStyle={{ "max-width": "440px" }}
                      value={
                        <div style={{ "text-align": "left" }}>
                          <div>累计耗时统计:     {fmtDuration(t().total)}</div>
                          <div style={{ "font-size": "10px", opacity: 0.6, "margin-top": "4px", }}>包含当前会话及子会话，并行执行时间会分别累计</div>
                          <hr style={{ margin: "2px 0", border: "none", "border-top": "1px solid currentColor", opacity: 0.3 }} />

                          <div>● 实际执行:   {fmtDuration(t().actual)} {pct(t().actual)}</div>
                          <div>● 工具执行:   {fmtDuration(t().tool)} {pct(t().tool)}
                            <div>● LLM 耗时:   {fmtDuration(t().llm)} {pct(t().llm)}
                              <span style={{ "font-size": "10px", opacity: 0.6, "margin-left": "10px", }}>
                                累计所有模型回复消息的模型处理时长，即模型开始生成到生成完成所用的时间
                              </span>
                            </div>
                          </div>
                          <Show when={t().wait > 0}>
                            <div>● 等待用户:   {fmtDuration(t().wait)} {pct(t().wait)}  <span style={{ "font-size": "10px", opacity: 0.6, "margin-left": "10px", }}>
                              累计所有需要用户回答或因输入无效而暂停的等待时间，并加上权限确认的等待时长
                            </span></div>
                            <Show when={t().permissionWait > 0}>
                              <div style={{ "margin-left": "12px" }}>权限等待: {fmtDuration(t().permissionWait)} {pct(t().permissionWait)}</div>
                            </Show>
                            <Show when={t().questionWait > 0}>
                              <div style={{ "margin-left": "12px" }}>问题等待: {fmtDuration(t().questionWait)} {pct(t().questionWait)}</div>
                            </Show>
                          </Show>
                          <Show when={t().total > t().llm + t().tool + t().wait}>
                            <div>● 其他开销:   {fmtDuration(t().total - t().llm - t().tool - t().wait)} {pct(t().total - t().llm - t().tool - t().wait)}
                              <span style={{ "font-size": "10px", opacity: 0.6, "margin-left": "10px", }}>
                                通常包含网络延迟、消息存储、session 管理等其他未单独统计的开销
                              </span>
                            </div>
                          </Show>
                          <hr style={{ margin: "4px 0", border: "none", "border-top": "1px solid currentColor", opacity: 0.3 }} />
                          <div style={{ "font-size": "10px", opacity: 0.6, "margin-top": "4px", "text-wrap": "wrap" }}>
                            LLM、工具和等待耗时按每次执行分别累加；父子会话并行时也会分别计入，不按实际经过时间去重，因此可能与本轮耗时不同
                          </div>
                        </div>
                      }
                      placement="bottom"
                    >
                      <span class="task-header-tokens-value" style={{ "font-weight": 600 }}>
                        累计耗时: {fmtDuration(t().total)}
                      </span>
                    </Tooltip>
                  </div>
                </div>
              )
            }}
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
