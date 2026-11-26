/**
 * TranscriptRowView component
 * Renders one row of the virtualized transcript (user / assistant part chunk /
 * timing / error / diff). Ported from the turn-level VscodeSessionTurn so each
 * turn no longer remounts as one giant DOM subtree while scrolling.
 *
 * testagent_change - new file (row-level architecture, upstream-derived)
 */

import { Component, For, Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { Dynamic } from "solid-js/web"
import { UserMessageDisplay } from "@kilocode/kilo-ui/message-part"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { Accordion } from "@kilocode/kilo-ui/accordion"
import { DiffChanges } from "@kilocode/kilo-ui/diff-changes"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { StickyAccordionHeader } from "@kilocode/kilo-ui/sticky-accordion-header"
import { useFileComponent } from "@kilocode/kilo-ui/context/file"
import { normalize } from "@kilocode/kilo-ui/session-diff"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import type {
  AssistantMessage as SDKAssistantMessage,
  Part as SDKPart,
  SnapshotFileDiff,
} from "@kilocode/sdk/v2"
import { AssistantMessage } from "./AssistantMessage"
import { ErrorDisplay } from "./ErrorDisplay"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { fmtTokens, type TranscriptRow } from "../../context/transcript-rows"

function getDirectory(path: string): string {
  const sep = path.includes("/") ? "/" : "\\"
  const idx = path.lastIndexOf(sep)
  return idx === -1 ? "" : path.slice(0, idx + 1)
}

function getFilename(path: string): string {
  const sep = path.includes("/") ? "/" : "\\"
  const idx = path.lastIndexOf(sep)
  return idx === -1 ? path : path.slice(idx + 1)
}

function forkAction(
  readonly: boolean | undefined,
  fork: TranscriptRowViewProps["onForkMessage"],
  msg: { id: string; sessionID: string },
) {
  if (readonly || !fork) return
  return () => fork(msg.sessionID, msg.id)
}

function revertAction(
  readonly: boolean | undefined,
  msg: { id: string },
  answered: boolean,
  reverted: boolean,
  session: ReturnType<typeof useSession>,
) {
  if (readonly || !answered || reverted || session.status() !== "idle") return
  return () => {
    if (session.status() !== "idle") return
    session.requestRevert(msg.id)
  }
}

interface TranscriptRowViewProps {
  row: TranscriptRow
  readonly?: boolean
  onForkMessage?: (sessionId: string, messageId: string) => void
}

export const TranscriptRowView: Component<TranscriptRowViewProps> = (props) => {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const server = useServer()
  const session = useSession()
  const language = useLanguage()

  createEffect(() => session.hydrateParts([props.row.message.id]))

  const user = createMemo(() => (props.row.type === "user" ? props.row : undefined))
  const assistant = createMemo(() => (props.row.type === "assistant" ? props.row : undefined))
  const timing = createMemo(() => (props.row.type === "timing" ? props.row : undefined))
  const errored = createMemo(() => (props.row.type === "error" ? props.row : undefined))
  const changed = createMemo(() => (props.row.type === "diff" ? props.row : undefined))

  const [open, setOpen] = createSignal(false)
  const [expanded, setExpanded] = createSignal<string[]>([])

  createEffect(
    on(
      open,
      (value, prev) => {
        if (!value && prev) setExpanded([])
      },
      { defer: true },
    ),
  )

  const busy = createMemo(() => !!user()?.answered && !session.revert() && session.status() !== "idle")

  return (
    <div
      class="vscode-session-turn"
      data-message={props.row.message.id}
      data-row={props.row.type}
      data-row-key={props.row.key}
      data-turn={props.row.turn}
      data-live={props.row.live ? "" : undefined}
    >
      <Show when={user()}>
        {(row) => (
          <div
            class="vscode-session-turn-user"
            data-revert-disabled={busy() ? "" : undefined}
            title={busy() ? language.t("revert.disabled.agentBusy") : undefined}
          >
            <UserMessageDisplay
              message={row().message as unknown as Parameters<typeof UserMessageDisplay>[0]["message"]}
              parts={row().parts as unknown as Parameters<typeof UserMessageDisplay>[0]["parts"]}
              interrupted={row().interrupted}
              queued={row().queued}
              onFork={forkAction(props.readonly, props.onForkMessage, row().message)}
              onRevert={revertAction(props.readonly, row().message, row().answered, !!session.revert(), session)}
            />
          </div>
        )}
      </Show>

      <Show when={assistant()}>
        {(row) => (
          <div class="vscode-session-turn-assistant">
            <AssistantMessage
              message={row().message as unknown as SDKAssistantMessage}
              parts={row().parts as unknown as SDKPart[]}
              readonly={props.readonly}
              showAssistantCopyPartID={row().copy}
            />
          </div>
        )}
      </Show>

      <Show when={timing()}>
        {(row) => {
          const stats = row().stats
          const tipParts = `本轮对话耗时从用户消息发送到agent响应完成的总花费时间，消耗tokens: ${fmtTokens(stats.totalTokens)}`
          return (
            <div
              style={{
                "font-size": "12px",
                color: "var(--vscode-descriptionForeground)",
                "margin-top": "-4px",
                padding: "2px 8px",
                opacity: "0.8",
              }}
            >
              <Tooltip placement="top-start" value={tipParts}>
                <span style={{ cursor: "pointer" }}>本轮对话耗时: {stats.duration ?? "未知"}</span>
              </Tooltip>
            </div>
          )
        }}
      </Show>

      <Show when={errored()}>
        {(row) => (
          <div style={{ position: "relative", margin: "8px 0", padding: "8px" }}>
            <ErrorDisplay error={row().error as unknown as Parameters<typeof ErrorDisplay>[0]["error"]} onLogin={server.startLogin} />
            <Show when={!props.readonly}>
              <div style={{ "margin-top": "8px" }}>
                <span
                  onClick={() => session.continueTask()}
                  style={{ width: "16px", display: "inline-block", cursor: "pointer" }}
                >
                  <Tooltip value={"重试"} placement="top">
                    <svg
                      viewBox="64 64 896 896"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="currentColor"
                      width="16"
                      height="16"
                    >
                      <path d="M758.2 839.1C851.8 765.9 912 651.9 912 523.9 912 303 733.5 124.3 512.6 124 291.4 123.7 112 302.8 112 523.9c0 125.2 57.5 236.9 147.6 310.2 3.5 2.8 8.6 2.2 11.4-1.3l39.4-50.5c2.7-3.4 2.1-8.3-1.2-11.1-8.1-6.6-15.9-13.7-23.4-21.2a318.64 318.64 0 01-68.6-101.7C200.4 609 192 567.1 192 523.9s8.4-85.1 25.1-124.5c16.1-38.1 39.2-72.3 68.6-101.7 29.4-29.4 63.6-52.5 101.7-68.6C426.9 212.4 468.8 204 512 204s85.1 8.4 124.5 25.1c38.1 16.1 72.3 39.2 101.7 68.6 29.4 29.4 63.6 52.5 101.7 68.6C796 369.4 812 411.3 812 468.7s-8.4 85.1-25.1 124.5a318.64 318.64 0 01-68.6 101.7c-9.3 9.3-19.1 18-29.3 26L668.2 724a8 8 0 00-14.1 3l-39.6 162.2c-1.2 5 2.6 9.9 7.7 9.9l167 .8c6.7 0 10.5-7.7 6.3-12.9l-37.3-47.9z"></path>
                    </svg>
                  </Tooltip>
                </span>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={changed()}>
        {(row) => {
          const changes = row().diffs as SnapshotFileDiff[]
          return (
            <Show when={server.gitInstalled()}>
              <div class="vscode-session-turn-diffs" data-component="session-turn">
                <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
                  <Collapsible.Trigger>
                    <div data-component="session-turn-diffs-trigger">
                      <div data-slot="session-turn-diffs-title">
                        <span data-slot="session-turn-diffs-label">{i18n.t("ui.sessionReview.change.modified")}</span>{" "}
                        <span data-slot="session-turn-diffs-count">
                          {changes.length} {i18n.t(changes.length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
                        </span>
                        <div data-slot="session-turn-diffs-meta">
                          <DiffChanges changes={changes} variant="bars" />
                          <Collapsible.Arrow />
                        </div>
                      </div>
                    </div>
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <Show when={open()}>
                      <div data-component="session-turn-diffs-content">
                        <Accordion
                          multiple
                          style={{ "--sticky-accordion-offset": "40px" }}
                          value={expanded()}
                          onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                        >
                          <For each={changes}>
                            {(diff) => {
                              const active = createMemo(() => expanded().includes(diff.file))
                              const [visible, setVisible] = createSignal(false)

                              createEffect(
                                on(
                                  active,
                                  (value) => {
                                    if (!value) {
                                      setVisible(false)
                                      return
                                    }
                                    requestAnimationFrame(() => {
                                      if (active()) setVisible(true)
                                    })
                                  },
                                  { defer: true },
                                ),
                              )

                              return (
                                <Accordion.Item value={diff.file}>
                                  <StickyAccordionHeader>
                                    <Accordion.Trigger>
                                      <div data-slot="session-turn-diff-trigger">
                                        <span data-slot="session-turn-diff-path">
                                          <Show when={diff.file.includes("/")}>
                                            <span data-slot="session-turn-diff-directory">
                                              {`\u2066${getDirectory(diff.file)}\u2069`}
                                            </span>
                                          </Show>
                                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                                        </span>
                                        <div data-slot="session-turn-diff-meta">
                                          <span data-slot="session-turn-diff-changes">
                                            <DiffChanges changes={diff} />
                                          </span>
                                          <span data-slot="session-turn-diff-chevron">
                                            <Icon name="chevron-down" size="small" />
                                          </span>
                                        </div>
                                      </div>
                                    </Accordion.Trigger>
                                  </StickyAccordionHeader>
                                  <Accordion.Content>
                                    <Show when={visible()}>
                                      <div data-slot="session-turn-diff-view" data-scrollable>
                                        <Dynamic component={fileComponent} mode="diff" fileDiff={normalize(diff).fileDiff} />
                                      </div>
                                    </Show>
                                  </Accordion.Content>
                                </Accordion.Item>
                              )
                            }}
                          </For>
                        </Accordion>
                      </div>
                    </Show>
                  </Collapsible.Content>
                </Collapsible>
              </div>
            </Show>
          )
        }}
      </Show>
    </div>
  )
}
