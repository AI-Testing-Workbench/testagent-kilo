// testagent_change - new file
/**
 * TestflowMessageBridge
 *
 * Translates testflow process events into the same messageCreated / partUpdated
 * messages that the opencode SSE pipeline produces, so the existing MessageList /
 * AssistantMessage / ToolRegistry rendering path handles testflow output natively.
 *
 * Event -> webview message mapping:
 *   progress       -> tool part  (tool: "testflow-progress", state: completed)
 *   response_part  -> tool/text  (forwarded to AssistantMessage for native rendering)
 *   new_assistant  -> closes current assistant message, opens a new one
 *   text / log     -> text part  (appended to the assistant message)
 *   error          -> text part  (prefixed with "! ")
 *   done           -> closes the assistant message (sessionStatus idle)
 */

import { randomUUID } from "crypto"

const uid = () => randomUUID()

export interface BridgeOpts {
  sessionID: string
  userText: string
  /** When provided, reuse this ID for the user message instead of generating a new one.
   *  This prevents a duplicate turn when the webview already created an optimistic message. */
  userMessageID?: string
  post: (msg: unknown) => void
}

export class TestflowMessageBridge {
  private sessionID = ""
  private userMsgID = ""
  private asstMsgID = ""
  private logPartID = ""
  private logText = ""
  private runID = ""
  private sequence = 0
  private startedAt = 0
  private latestProgress: {
    taskName: string
    totalCount: number
    completedCount: number
    percent: number
    currentStageID: string | null
    currentStageIndex: number | null
    stages: unknown[]
    nextHint: string | null
    exceptionHint: string | null
    errorMessage: string | null
  } | null = null
  private finished = false
  private post: ((msg: unknown) => void) | null = null

  start(opts: BridgeOpts): void {
    this.sessionID = opts.sessionID
    this.post = opts.post
    this.logPartID = ""
    this.logText = ""
    this.runID = uid()
    this.sequence = 0
    this.startedAt = Date.now()
    this.latestProgress = null
    this.finished = false

    this.post({
      type: "sdt.started",
      sessionID: opts.sessionID,
      runID: this.runID,
      taskName: opts.userText,
      startedAt: this.startedAt,
    })

    const now = this.startedAt
    this.userMsgID = opts.userMessageID ?? uid()
    this.asstMsgID = uid()

    // 1. Inject/confirm the user message.
    //    If userMessageID was provided, the webview already has an optimistic entry with this ID.
    //    Posting messageCreated with the same ID merges (updates) it rather than adding a duplicate.
    //    We include the text part inline so handleMessageCreated's wasOptimistic branch (which clears
    //    parts) is immediately followed by re-hydration from message.parts.
    const userTextPart = {
      type: "text" as const,
      id: uid(),
      messageID: this.userMsgID,
      text: opts.userText,
    }
    this.post({
      type: "messageCreated",
      message: {
        id: this.userMsgID,
        sessionID: this.sessionID,
        role: "user",
        createdAt: new Date(now).toISOString(),
        time: { created: now },
        // Always include parts so the store is hydrated even when wasOptimistic clears them.
        parts: [userTextPart],
      },
    })

    // 2. Inject the assistant message shell (no parts yet)
    this.post({
      type: "messageCreated",
      message: {
        id: this.asstMsgID,
        sessionID: this.sessionID,
        role: "assistant",
        parentID: this.userMsgID,
        createdAt: new Date(now + 1).toISOString(),
        time: { created: now + 1 },
      },
    })

    // 3. Mark session as busy
    this.post({ type: "sessionStatus", sessionID: this.sessionID, status: "busy" })
  }

  onProgress(
    taskName: string,
    stages: any[],
    completedCount: number,
    totalCount: number,
    percent: number,
    nextHint: string,
    exceptionHint: string | null,
  ): void {
    const partID = uid()
    this.post?.({
      type: "partUpdated",
      sessionID: this.sessionID,
      messageID: this.asstMsgID,
      part: {
        type: "tool",
        id: partID,
        callID: uid(),
        sessionID: this.sessionID,
        messageID: this.asstMsgID,
        tool: "testflow-progress",
        state: {
          status: "completed",
          input: { taskName, stages, completedCount, totalCount, percent, nextHint, exceptionHint },
          title: `任务清单 [${taskName}]`,
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      },
    })
  }

  receiveProgress(
    taskName: string,
    stages: unknown[],
    completedCount: number,
    totalCount: number,
    percent: number,
    nextHint: string | null,
    exceptionHint: string | null,
    currentStageID: string | null = null,
    currentStageIndex: number | null = null,
    errorMessage: string | null = null,
  ): void {
    this.latestProgress = {
      taskName,
      stages,
      completedCount,
      totalCount,
      percent,
      nextHint,
      exceptionHint,
      currentStageID,
      currentStageIndex,
      errorMessage,
    }
    this.sequence += 1
    this.post?.({
      type: "sdt.progress",
      sessionID: this.sessionID,
      runID: this.runID,
      sequence: this.sequence,
      taskName,
      totalCount,
      completedCount,
      percent,
      currentStageID,
      currentStageIndex,
      stages,
      nextHint,
      exceptionHint,
      errorMessage,
    })
  }

  onFinished(status: "completed" | "failed" | "aborted", detail: string | null = null): void {
    if (this.finished) return
    this.finished = true
    const latest = this.latestProgress
    this.post?.({
      type: "sdt.finished",
      sessionID: this.sessionID,
      runID: this.runID,
      status,
      finishedAt: Date.now(),
      taskName: latest?.taskName ?? "",
      totalCount: latest?.totalCount ?? 0,
      currentStageID: latest?.currentStageID ?? null,
      currentStageIndex: latest?.currentStageIndex ?? null,
      completedCount: latest?.completedCount ?? 0,
      percent: latest?.percent ?? 0,
      stages: latest?.stages ?? [],
      detail,
      errorMessage: latest?.errorMessage ?? detail,
    })
  }

  onNewAssistant(): void {
    const now = Date.now()
    // Close the current assistant message
    this.post?.({
      type: "messageCreated",
      message: {
        id: this.asstMsgID,
        sessionID: this.sessionID,
        role: "assistant",
        parentID: this.userMsgID,
        createdAt: new Date(now).toISOString(),
        time: { created: now, completed: now },
        finish: "stop",
      },
    })

    // Create a new assistant message shell
    this.asstMsgID = uid()
    this.logPartID = ""
    this.logText = ""

    this.post?.({
      type: "messageCreated",
      message: {
        id: this.asstMsgID,
        sessionID: this.sessionID,
        role: "assistant",
        parentID: this.userMsgID,
        createdAt: new Date(now + 1).toISOString(),
        time: { created: now + 1 },
      },
    })
  }

  onResponsePart(sessionID: string, messageID: string, sequence: number, part: any): void {
    void sessionID
    void messageID
    // Check if this is a task tool part - trigger child session sync if so
    if (part.type === 'tool' && part.tool === 'task') {
      const childSessionId = part.state?.metadata?.sessionId
      if (childSessionId) {
        this.post?.({
          type: "testflow.syncChildSession",
          sessionID: childSessionId,
        })
      }
    }

    // Forward part to webview
    this.post?.({
      type: "partUpdated",
      sessionID: this.sessionID,
      messageID: this.asstMsgID,
      sequence,
      part: {
        ...part,
        id: part.id || uid(),
        messageID: this.asstMsgID,
      },
    })
  }

  onLog(level: string, message: string): void {
    this.appendLog(`${level === "error" ? "! " : ""}${message}`)
  }

  onText(text: string): void {
    this.appendLog(text)
  }

  onError(error: string): void {
    this.appendLog(`! ${error}`)
  }

  /**
   * 一锤子命令的最终结果。bridge 将其转为一个 tool: "testflow-result" 的
   * completed part 渲染成结果卡，渲染细节由 webview 端按 `kind` 分支处理。
   */
  onResult(payload: Record<string, unknown>): void {
    const kind = (payload.kind as string) ?? "unknown"
    const titles: Record<string, string> = {
      init: "初始化 TestFlow 框架",
      new: "创建测试任务",
      list: "任务列表",
      switch: "切换默认任务",
      validate: "校验流程配置",
      "config-update": "更新项目配置",
      error: "命令执行失败",
      help: "命令帮助",
    }
    const title = titles[kind] ?? "命令结果"
    this.post?.({
      type: "partUpdated",
      sessionID: this.sessionID,
      messageID: this.asstMsgID,
      part: {
        type: "tool",
        id: uid(),
        callID: uid(),
        sessionID: this.sessionID,
        messageID: this.asstMsgID,
        tool: "testflow-result",
        state: {
          status: "completed",
          input: { kind, ...payload },
          output: JSON.stringify(payload, null, 2),
          title,
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      },
    })
  }

  onDone(exitCode: number, summary?: string): void {
    if (summary) this.appendLog(summary)
    this.onFinished(exitCode === 0 ? "completed" : "failed", summary ?? null)

    const now = Date.now()
    // Close the assistant message with a completed timestamp
    this.post?.({
      type: "messageCreated",
      message: {
        id: this.asstMsgID,
        sessionID: this.sessionID,
        role: "assistant",
        parentID: this.userMsgID,
        createdAt: new Date(now).toISOString(),
        time: { created: now, completed: now },
        finish: exitCode === 0 ? "stop" : "error",
      },
    })
    // Mark session idle
    this.post?.({ type: "sessionStatus", sessionID: this.sessionID, status: "idle" })
  }

  private appendLog(text: string): void {
    if (!text.trim()) return
    this.logText = this.logText ? `${this.logText}\n${text}` : text

    if (!this.logPartID) {
      this.logPartID = uid()
    }

    this.post?.({
      type: "partUpdated",
      sessionID: this.sessionID,
      messageID: this.asstMsgID,
      part: {
        type: "text",
        id: this.logPartID,
        messageID: this.asstMsgID,
        text: this.logText,
        // Mark as testflow log so the webview can render it with pre-wrap styling
        testflow: true,
      },
    })
  }
}
