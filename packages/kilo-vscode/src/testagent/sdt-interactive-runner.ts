// testagent_change - new file
/**
 * 交互式运行 /sdt-run 的 handler
 *
 * 当用户直接发送 /sdt-run（不带 stage_id 参数）时，
 * 自动查询阶段列表，然后以 QuestionRequest 形式让用户选择，
 * 最后用选中的 stage_id 执行命令。
 */

import { SdtRunner } from "./sdt-runner"

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface DeferredEntry {
  deferred: { resolve: (value: string) => void; reject: (reason?: any) => void }
  timeout: NodeJS.Timeout
}

export interface InteractiveRunContext {
  sdtRunner: SdtRunner
  localQuestionMap: Map<string, DeferredEntry>
  postMessage(msg: unknown): void
  showErrorMessage(message: string): void
}

export interface InteractiveRunMeta {
  providerID?: string
  modelID?: string
  agent?: string
  messageID?: string
  sessionID?: string
}

// ---------------------------------------------------------------------------
// handleInteractiveRun
// ---------------------------------------------------------------------------

/**
 * 交互式运行 /sdt-run：自动查询阶段列表 → 让用户选择 → 执行
 * 仅在 /sdt-run 不带 stage_id 参数时触发
 */
export async function handleInteractiveRun(
  ctx: InteractiveRunContext,
  resolved: { dir: string; sid: string },
  serverConfig: { baseUrl: string; password: string },
  meta: InteractiveRunMeta,
): Promise<void> {
  // 1. 查询阶段列表（testflow stages 自动从 .sdt_config.yaml 解析当前任务名）
  let stages: { stage_id: string; stage_name: string; description: string }[]
  let taskName: string
  try {
    const result = await ctx.sdtRunner.queryOnce({
      cmd: 'stages',
      args: ['--dir', resolved.dir],
      cwd: resolved.dir,
      env: {
        OPENCODE_SERVER_URL: serverConfig.baseUrl,
        OPENCODE_SERVER_PASSWORD: serverConfig.password,
        OPENCODE_SESSION_ID: resolved.sid,
      },
      sessionID: resolved.sid,
      userText: '/sdt-stages',
      post: () => {},
    })
    taskName = (result as any).taskName as string
    stages = (result as any).stages as typeof stages
  } catch (err) {
    ctx.showErrorMessage(`获取阶段列表失败：${err}`)
    return
  }

  if (!stages || stages.length === 0) {
    ctx.showErrorMessage(`任务「${taskName || '当前任务'}」没有可执行的阶段`)
    return
  }

  // 2. 只有一个阶段 → 直接执行，跳过选择
  if (stages.length === 1) {
    ctx.sdtRunner.run({
      cmd: 'run',
      args: [stages[0].stage_id],
      cwd: resolved.dir,
      env: {
        OPENCODE_SERVER_URL: serverConfig.baseUrl,
        OPENCODE_SERVER_PASSWORD: serverConfig.password,
        OPENCODE_SESSION_ID: resolved.sid,
        OPENCODE_PROVIDER_ID: meta.providerID || '',
        OPENCODE_MODEL_ID: meta.modelID || '',
        OPENCODE_AGENT: meta.agent,
        SDT_USER_TEXT: `/sdt-run ${stages[0].stage_id}`,
      },
      sessionID: resolved.sid,
      userText: `/sdt-run ${stages[0].stage_id}`,
      userMessageID: meta.messageID,
      post: (msg) => ctx.postMessage(msg),
    })
    return
  }

  // 3. 多个阶段 → 发送 QuestionRequest 到 webview，让用户选择
  const requestID = 'sdt-local:' + crypto.randomUUID()

  // 创建 Deferred Promise（用于等待用户选择）
  let resolveDeferred: (value: string) => void = () => {}
  let rejectDeferred: (reason?: any) => void = () => {}
  const deferred = new Promise<string>((res, rej) => {
    resolveDeferred = res
    rejectDeferred = rej
  })

  // 5 分钟超时自动取消
  const timeout = setTimeout(() => {
    ctx.localQuestionMap.delete(requestID)
    rejectDeferred(new Error('阶段选择超时'))
  }, 5 * 60 * 1000)

  ctx.localQuestionMap.set(requestID, {
    deferred: { resolve: resolveDeferred, reject: rejectDeferred },
    timeout,
  })

  // 先创建用户消息（新会话中 webview 不会创建乐观消息）
  const userMsgID = meta.messageID || crypto.randomUUID()
  const userTextPart = {
    type: 'text' as const,
    id: crypto.randomUUID(),
    messageID: userMsgID,
    text: `/sdt-run`,
  }
  ctx.postMessage({
    type: 'messageCreated',
    message: {
      id: userMsgID,
      sessionID: resolved.sid,
      role: 'user',
      createdAt: new Date().toISOString(),
      time: { created: Date.now() },
      parts: [userTextPart],
    },
  })

  ctx.postMessage({
    type: 'questionRequest',
    question: {
      id: requestID,
      sessionID: resolved.sid,
      questions: [{
        header: '选择执行阶段',
        question: `任务「${taskName}」的阶段列表：`,
        options: stages.map(s => ({
          label: s.stage_name,
          description: s.description || s.stage_id,
        })),
        custom: true,
      }],
    },
  })

  // 4. 等待用户选择
  let selectedStageId: string
  try {
    const selectedLabel = await deferred
    const selected = stages.find(s => s.stage_name === selectedLabel)
    selectedStageId = selected?.stage_id ?? selectedLabel
  } catch {
    // 用户取消选择或超时
    ctx.postMessage({ type: 'questionResolved', requestID })
    return
  } finally {
    clearTimeout(timeout)
    ctx.localQuestionMap.delete(requestID)
  }

  // 5. 告知 webview 该 question 已处理
  ctx.postMessage({ type: 'questionResolved', requestID })

  // 6. 执行选中的阶段
  ctx.sdtRunner.run({
    cmd: 'run',
    args: [selectedStageId],
    cwd: resolved.dir,
    env: {
      OPENCODE_SERVER_URL: serverConfig.baseUrl,
      OPENCODE_SERVER_PASSWORD: serverConfig.password,
      OPENCODE_SESSION_ID: resolved.sid,
      OPENCODE_PROVIDER_ID: meta.providerID || '',
      OPENCODE_MODEL_ID: meta.modelID || '',
      OPENCODE_AGENT: meta.agent,
      SDT_USER_TEXT: `/sdt-run ${selectedStageId}`,
    },
    sessionID: resolved.sid,
    userText: `/sdt-run ${selectedStageId}`,
    userMessageID: userMsgID,
    post: (msg) => ctx.postMessage(msg),
  })
}