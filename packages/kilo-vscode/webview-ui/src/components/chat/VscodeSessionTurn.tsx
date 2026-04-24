/**
 * VscodeSessionTurn component
 * Custom replacement for the upstream SessionTurn, designed for the VS Code sidebar.
 *
 * Key differences from upstream SessionTurn:
 * - No "Gathered context" grouping — each tool call is rendered individually
 * - Sub-agents are fully expanded inline via TaskToolExpanded
 * - No per-turn auto-scroll (MessageList handles it)
 * - Simpler flat structure without overflow containers
 */

import { Component, createMemo, For, Show, createSignal, createEffect, on } from "solid-js"
import { Dynamic } from "solid-js/web"
import { UserMessageDisplay } from "@kilocode/kilo-ui/message-part"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { Accordion } from "@kilocode/kilo-ui/accordion"
import { DiffChanges } from "@kilocode/kilo-ui/diff-changes"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { StickyAccordionHeader } from "@kilocode/kilo-ui/sticky-accordion-header"
import { useData } from "@kilocode/kilo-ui/context/data"
import { useFileComponent } from "@kilocode/kilo-ui/context/file"
import { normalize } from "@kilocode/kilo-ui/session-diff"
import { useI18n } from "@kilocode/kilo-ui/context/i18n"
import { AssistantMessage } from "./AssistantMessage"
import type {
  AssistantMessage as SDKAssistantMessage,
  Message as SDKMessage,
  Part as SDKPart,
  SnapshotFileDiff,
} from "@kilocode/sdk/v2"
import { ErrorDisplay } from "./ErrorDisplay"
import { useServer } from "../../context/server"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import type { Message as WebMessage } from "../../types/messages"

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

export interface VscodeTurn {
  id: string
  user: WebMessage
  assistant: WebMessage[]
}

interface VscodeSessionTurnProps {
  turn: VscodeTurn
  queued?: boolean
  onForkMessage?: (sessionId: string, messageId: string) => void
}

export const VscodeSessionTurn: Component<VscodeSessionTurnProps> = (props) => {
  const data = useData()
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const server = useServer()
  const session = useSession()
  const language = useLanguage()

  const emptyParts: SDKPart[] = []
  const emptyDiffs: SnapshotFileDiff[] = []

  createEffect(() => {
    const turn = props.turn
    session.hydrateParts([turn.user.id, ...turn.assistant.map((m) => m.id)])
  })

  const message = createMemo(() => props.turn.user as SDKMessage & { role: "user" })

  const parts = createMemo(() => {
    const msg = message()
    return (data.store.part?.[msg.id] ?? emptyParts) as SDKPart[]
  })

  const assistantMessages = createMemo(() => props.turn.assistant as SDKAssistantMessage[])

  const interrupted = createMemo(() => assistantMessages().some((m) => m.error?.name === "MessageAbortedError"))

  const error = createMemo(
    () => assistantMessages().find((m) => m.error && m.error.name !== "MessageAbortedError")?.error,
  )

  // Diffs from message summary
  const diffs = createMemo(() => {
    const rawDiffs = (message() as unknown as { summary?: { diffs?: unknown[] } } | undefined)?.summary?.diffs
    if (!rawDiffs?.length) return emptyDiffs
    const seen = new Set<string>()
    return (rawDiffs as SnapshotFileDiff[])
      .reduceRight<SnapshotFileDiff[]>((result, diff) => {
        if (seen.has(diff.file)) return result
        seen.add(diff.file)
        result.push(diff)
        return result
      }, [])
      .reverse()
  })

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

  // Copy part ID — the last text part from the last assistant message
  const showAssistantCopyPartID = createMemo(() => {
    const msgs = assistantMessages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      const msgParts = (data.store.part?.[msg.id] ?? emptyParts) as SDKPart[]
      for (let j = msgParts.length - 1; j >= 0; j--) {
        const part = msgParts[j]
        if (!part || part.type !== "text") continue
        if ((part as SDKPart & { text: string }).text?.trim()) return part.id
      }
    }
    return undefined
  })

  return (
    <Show when={message()}>
      {(msg) => (
        <div class="vscode-session-turn" data-message={msg().id}>
          {/* User message */}
          <div
            class="vscode-session-turn-user"
            data-revert-disabled={
              assistantMessages().length > 0 && !session.revert() && session.status() !== "idle" ? "" : undefined
            }
            title={
              assistantMessages().length > 0 && !session.revert() && session.status() !== "idle"
                ? language.t("revert.disabled.agentBusy")
                : undefined
            }
          >
            <UserMessageDisplay
              message={msg() as unknown as Parameters<typeof UserMessageDisplay>[0]["message"]}
              parts={parts() as unknown as Parameters<typeof UserMessageDisplay>[0]["parts"]}
              interrupted={interrupted()}
              queued={props.queued}
              onFork={props.onForkMessage ? () => props.onForkMessage?.(msg().sessionID, msg().id) : undefined}
              onRevert={
                assistantMessages().length > 0 && !session.revert()
                  ? () => {
                      if (session.status() !== "idle") return
                      session.revertSession(msg().id)
                    }
                  : undefined
              }
            />
          </div>

          {/* Assistant parts — flat list, no context grouping */}
          <Show when={assistantMessages().length > 0}>
            <div class="vscode-session-turn-assistant">
              <For each={assistantMessages()}>
                {(msg) => <AssistantMessage message={msg} showAssistantCopyPartID={showAssistantCopyPartID()} />}
              </For>
            </div>
          </Show>

          {/* Diff summary — shown after completion */}
          <Show when={diffs().length > 0 && server.gitInstalled()}>
            <div class="vscode-session-turn-diffs" data-component="session-turn">
              <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
                <Collapsible.Trigger>
                  <div data-component="session-turn-diffs-trigger">
                    <div data-slot="session-turn-diffs-title">
                      <span data-slot="session-turn-diffs-label">{i18n.t("ui.sessionReview.change.modified")}</span>{" "}
                      <span data-slot="session-turn-diffs-count">
                        {diffs().length} {i18n.t(diffs().length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
                      </span>
                      <div data-slot="session-turn-diffs-meta">
                        <DiffChanges changes={diffs()} variant="bars" />
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
                        <For each={diffs()}>
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
                                      <Dynamic
                                        component={fileComponent}
                                        mode="diff"
                                        fileDiff={normalize(diff).fileDiff}
                                      />
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

          {/* Error handling */}
          <Show when={error()}>
            <ErrorDisplay error={error()!} onLogin={server.startLogin} />
            <div>
              <span
                onClick={() => {
                  const msg = message()
                  if (!msg) return
                  const textPart = (data.store.part?.[msg.id] ?? emptyParts).find((p) => p.type === "text") as
                    | { type: "text"; text: string }
                    | undefined
                  if (textPart?.text) {
                    const sel = session.selected()
                    session.sendMessage(textPart.text, sel?.providerID, sel?.modelID)
                  }
                }}
                style={{ width: "16px", display: "inline-block" ,cursor: "pointer"}}
              >
                <Tooltip value={"重试"} placement="top">
                  <svg
                    viewBox="64 64 896 896"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="currentColor"
                    width="16"
                    height="16"
                  >
                    <path d="M758.2 839.1C851.8 765.9 912 651.9 912 523.9 912 303 733.5 124.3 512.6 124 291.4 123.7 112 302.8 112 523.9c0 125.2 57.5 236.9 147.6 310.2 3.5 2.8 8.6 2.2 11.4-1.3l39.4-50.5c2.7-3.4 2.1-8.3-1.2-11.1-8.1-6.6-15.9-13.7-23.4-21.2a318.64 318.64 0 01-68.6-101.7C200.4 609 192 567.1 192 523.9s8.4-85.1 25.1-124.5c16.1-38.1 39.2-72.3 68.6-101.7 29.4-29.4 63.6-52.5 101.7-68.6C426.9 212.4 468.8 204 512 204s85.1 8.4 124.5 25.1c38.1 16.1 72.3 39.2 101.7 68.6 29.4 29.4 52.5 63.6 68.6 101.7 16.7 39.4 25.1 81.3 25.1 124.5s-8.4 85.1-25.1 124.5a318.64 318.64 0 01-68.6 101.7c-9.3 9.3-19.1 18-29.3 26L668.2 724a8 8 0 00-14.1 3l-39.6 162.2c-1.2 5 2.6 9.9 7.7 9.9l167 .8c6.7 0 10.5-7.7 6.3-12.9l-37.3-47.9z"></path>
                  </svg>
                </Tooltip>
              </span>
               <span
                onClick={() => {
                  const sel = session.selected()
                  session.sendMessage("继续", sel?.providerID, sel?.modelID)
                }}
                style={{ width: "16px", display: "inline-block", cursor: "pointer" }}
              >
                <Tooltip value={"继续"} placement="top">
                  <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="4" width="16" height="16"><path d="M14 24L7 19V7L41 24L7 41V29L14 24ZM14 24H39" stroke-miterlimit="3.8637" stroke-linecap="butt"></path></svg>
                </Tooltip>
              </span>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
