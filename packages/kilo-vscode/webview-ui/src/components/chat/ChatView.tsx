/**
 * ChatView component
 * Main chat container that combines all chat components
 */

import { Component, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { showToast } from "@kilocode/kilo-ui/toast"
import { TaskHeader } from "./TaskHeader"
import { MessageList } from "./MessageList"
import { PromptInput } from "./PromptInput"
import { PermissionDock } from "./PermissionDock"
import { QuestionDock } from "./QuestionDock"
import { RevertConfirmDock } from "./RevertConfirmDock"
import { StartupErrorBanner } from "./StartupErrorBanner"
import { SessionTabStrip } from "./SessionTabStrip"
import { ConfigWarningsBanner } from "./ConfigWarningsBanner"
import { ChatTip } from "./ChatTip"
import { useSession } from "../../context/session"
import { useLocalTabs } from "../../context/local-tabs"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { useWorktreeMode } from "../../context/worktree-mode"
import { useServer } from "../../context/server"
import { isPromptBlocked, isSuggesting, isQuestioning } from "./prompt-input-utils"
import { SdtProgressCard } from "./sdt/SdtProgressCard"

interface ChatViewProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
  onForkMessage?: (sessionId: string, messageId: string) => void
  readonly?: boolean
  /** When true, show the "Continue in Worktree" button. Defaults to true in the sidebar. */
  continueInWorktree?: boolean
  promptBoxId?: string
  pendingSessionID?: string
}

export const ChatView: Component<ChatViewProps> = (props) => {
  const session = useSession()
  const tabs = useLocalTabs()
  const vscode = useVSCode()
  const language = useLanguage()
  const worktreeMode = useWorktreeMode()
  const server = useServer()
  // Show "Show Changes" only in the standalone sidebar, not inside Agent Manager
  const isSidebar = () => worktreeMode === undefined
  // Show "Continue in Worktree": only when explicitly enabled via prop
  const canContinueInWorktree = () => props.continueInWorktree === true

  // Show tab strip when multiple tabs are open
  const showTabStrip = () => isSidebar() && !props.readonly && tabs && tabs.ids().length > 1

  const id = () => session.currentSessionID()
  const hasMessages = () => session.messages().length > 0
  const idle = () => session.status() !== "busy"

  // testagent_change start - 判断最后一条 assistant 消息是否处于可继续状态（出错或被中断）
  const lastAssistantMsg = () => {
    const msgs = session.messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i]
    }
    return undefined
  }
  const canContinue = () => {
    // 重试中不显示继续按钮
    if (session.status() !== "idle") return false
    const msg = lastAssistantMsg()
    if (!msg) return false
    // 有 error 字段 → 出错
    if (msg.error) return true
    // 有 finish 且不是中间状态 → 正常完成，不需要继续
    if (msg.finish && !["tool-calls", "unknown"].includes(msg.finish)) return false
    // 没有有效 finish → 被中断（含窗口关闭强制退出）
    return true
  }
  // testagent_change end

  // "Continue in Worktree" state
  const [transferring, setTransferring] = createSignal(false)
  const [transferDetail, setTransferDetail] = createSignal("")

  // Permissions and questions scoped to this session's family (self + subagents).
  // Each ChatView only sees its own session tree — no cross-session leakage.
  // Memoized so the BFS walk in sessionFamily() runs once per reactive update,
  // not once per accessor call (questionRequest, permissionRequest, blocked all read these).
  const familyPermissions = createMemo(() => session.scopedPermissions(id()))
  const familyQuestions = createMemo(() => session.scopedQuestions(id()))
  const familySuggestions = createMemo(() => session.scopedSuggestions(id()))
  // Non-tool questions (standalone, not from the question tool) render inline in
  // the message list since they don't have an associated tool part in the conversation.
  // Tool-linked questions render inline at their tool part position via AssistantMessage.
  // Only this session's own standalone questions render in the message list — questions
  // from child subagents surface in the bottom dock instead (mirroring PermissionDock).
  const standaloneQuestions = createMemo(() => familyQuestions().filter((q) => !q.tool && q.sessionID === id()))
  const standaloneSuggestions = createMemo(() => familySuggestions().filter((s) => !s.tool))
  const permissionRequest = () => familyPermissions().find((p) => p.sessionID === id()) ?? familyPermissions()[0]
  // A pending question from a child subagent. The child's message list isn't visible
  // here, so surface the QuestionDock in the bottom dock so the user can answer the
  // subagent directly — same pattern as the PermissionDock for child permissions.
  const delegatedQuestionRequest = () => familyQuestions().find((q) => q.sessionID !== id())
  // Prompt input is decoupled from questions/suggestions — only permissions block.
  // Pending questions and suggestions are auto-dismissed in sendMessage/sendCommand.
  const blocked = () => isPromptBlocked(familyPermissions().length)
  // Session is busy only because a suggestion tool call is pending — prompt should behave as idle
  const suggesting = () => isSuggesting(blocked(), familySuggestions().length)
  // Session is busy only because a question tool call is pending — prompt should behave as idle
  const questioning = () => isQuestioning(blocked(), familyQuestions().length)
  // testagent_change - 检查点重置确认时也展示 dock 区域
  const dock = () =>
    !props.readonly || !!permissionRequest() || !!delegatedQuestionRequest() || !!session.revertConfirm()

  // When a bottom-dock permission disappears while the session is busy,
  // the scroll container grows taller. Dispatch a custom event so MessageList can
  // resume auto-scroll.
  createEffect(
    on(blocked, (isBlocked, wasBlocked) => {
      if (wasBlocked && !isBlocked && !idle()) {
        window.dispatchEvent(new CustomEvent("resumeAutoScroll"))
      }
    }),
  )

  onMount(() => {
    if (props.readonly) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || session.status() === "idle" || e.defaultPrevented) return
      e.preventDefault()
      session.abort()
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  // Listen for "Continue in Worktree" progress messages
  {
    const labels: Record<string, string> = {
      capturing: "Capturing changes...",
      creating: "Creating worktree...",
      setup: "Running setup...",
      transferring: "Transferring changes...",
      forking: "Starting session...",
    }
    const cleanup = vscode.onMessage((msg) => {
      if (msg.type !== "continueInWorktreeProgress") return
      const m = msg as { status: string; error?: string }
      if (m.status === "done") {
        setTransferring(false)
        setTransferDetail("")
        return
      }
      if (m.status === "error") {
        setTransferring(false)
        setTransferDetail("")
        showToast({ title: m.error ?? "Failed to continue in worktree" })
        return
      }
      setTransferDetail(labels[m.status] ?? "Working...")
    })
    onCleanup(cleanup)
  }

  const decide = (response: "once" | "always" | "reject", approvedAlways: string[], deniedAlways: string[]) => {
    const perm = permissionRequest()
    if (!perm || session.respondingPermissions().has(perm.id)) return
    session.respondToPermission(perm.id, response, approvedAlways, deniedAlways)
  }

  return (
    <div class="chat-view">
      <Show when={showTabStrip()}>
        <SessionTabStrip />
      </Show>
      <TaskHeader readonly={props.readonly} />
      <div class="chat-messages-wrapper">
        <div class="chat-messages">
          <MessageList
            onSelectSession={props.onSelectSession}
            onShowHistory={props.onShowHistory}
            onForkMessage={props.onForkMessage}
            questions={standaloneQuestions}
            suggestions={standaloneSuggestions}
            readonly={props.readonly}
          />
        </div>
      </div>

      <Show when={dock()}>
        <div class="chat-input">
          <Show when={server.connectionState() === "error" && server.errorMessage()}>
            <StartupErrorBanner errorMessage={server.errorMessage()!} errorDetails={server.errorDetails()!} />
          </Show>
          <Show when={permissionRequest()} keyed>
            {(perm) => (
              <PermissionDock
                request={perm}
                responding={session.respondingPermissions().has(perm.id)}
                onDecide={decide}
              />
            )}
          </Show>
          <Show when={delegatedQuestionRequest()} keyed>
            {(q) => <QuestionDock request={q} />}
          </Show>
          {/* testagent_change start - 检查点重置确认dock，与权限确认弹窗位置一致 */}
          <Show when={session.revertConfirm()}>
            <RevertConfirmDock />
          </Show>
          {/* testagent_change end */}
          <Show when={!props.readonly && hasMessages() && idle() && !blocked() && !session.revertConfirm()}>
            <div class="new-task-button-wrapper">
              <div class="session-actions-row">
                {/* testagent_change start - 继续按钮：仅在出错或中断时显示 */}
                <Show when={canContinue()}>
                  <Tooltip value="继续当前任务" placement="top">
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => {
                        session.continueTask()
                      }}
                      aria-label={language.t("command.session.continue")}
                    >
                      {language.t("command.session.continue")}
                    </Button>
                  </Tooltip>
                </Show>
                {/* testagent_change end */}

                <Tooltip value="Start a new conversation" placement="top">
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => window.dispatchEvent(new CustomEvent("newTaskRequestReplace"))}
                    aria-label={language.t("command.session.new.task")}
                  >
                    {language.t("command.session.new.task")}
                  </Button>
                </Tooltip>
                {/* testagent_change 注释掉 worktree */}
                {/* <Show when={canContinueInWorktree()}>
                  <Tooltip value="Continue in isolated worktree" placement="top">
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={transferring()}
                      onClick={() => {
                        const sid = id()
                        if (!sid) return
                        setTransferring(true)
                        setTransferDetail("Capturing changes...")
                        vscode.postMessage({ type: "continueInWorktree", sessionId: sid })
                      }}
                      aria-label="Continue in Worktree"
                    >
                      <Show when={transferring()} fallback={<Icon name="branch" size="small" />}>
                        <Spinner class="chat-spinner-small" />
                      </Show>
                      {transferring() ? transferDetail() : "Worktree"}
                    </Button>
                  </Tooltip>
                </Show>
                  */}
                <Show when={isSidebar() && server.gitInstalled()}>
                  <Tooltip
                    value={
                      session.worktreeStats()?.files
                        ? `${session.worktreeStats()!.files} file${session.worktreeStats()!.files > 1 ? "s" : ""} changed · +${session.worktreeStats()!.additions} -${session.worktreeStats()!.deletions}`
                        : "No file changes"
                    }
                    placement="top"
                    class="session-diff-wrapper"
                  >
                    <button
                      class="session-diff-badge"
                      classList={{
                        "session-diff-badge--empty": !session.worktreeStats()?.files,
                        "session-diff-badge--has-changes": !!session.worktreeStats()?.files,
                      }}
                      onClick={() => vscode.postMessage({ type: "openChanges" })}
                      aria-label={language.t("command.session.show.changes")}
                    >
                      <Icon name="layers" size="small" />
                      <Show when={session.worktreeStats()?.files}>
                        <span class="session-diff-add">+{session.worktreeStats()!.additions}</span>
                        <span class="session-diff-del">-{session.worktreeStats()!.deletions}</span>
                      </Show>
                    </button>
                  </Tooltip>
                </Show>
              </div>
            </div>
          </Show>
          <ConfigWarningsBanner />
          <Show when={session.sdtProgress()}>
            {(progress) => <SdtProgressCard progress={progress()} onDismiss={session.dismissSdtProgress} />}
          </Show>
          <Show when={!props.readonly}>
            <ChatTip />
            <PromptInput
              blocked={blocked}
              suggesting={suggesting}
              questioning={questioning}
              locked={() => !!session.revertConfirm()}
              boxId={props.promptBoxId}
              pendingSessionID={props.pendingSessionID ?? tabs?.pending()}
            />
          </Show>
        </div>
      </Show>
    </div>
  )
}
