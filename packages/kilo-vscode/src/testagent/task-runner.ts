// testagent_change - new file
import { randomUUID } from "crypto"

const uid = () => randomUUID()

const BASE = "http://fastautomator-openapi-group.paas.cmbchina.cn"
const EXEC = `${BASE}/mobile-execution`
const TASK_TYPE = 4
const TIMEOUT = 30_000

const STATUS: Record<number, string> = {
  0: "等待执行",
  1: "正在执行",
  2: "执行成功",
  3: "执行失败",
  4: "取消执行",
}

const TYPES: Record<number, string> = {
  0: "普通执行集任务",
  1: "普通执行集重跑任务",
  2: "并发执行集任务",
  4: "高码案例执行集任务",
}

export interface TaskRunnerOpts {
  cmd: "query"
  args: string[]
  cwd: string
  sessionID: string
  userText: string
  userMessageID?: string
  post: (msg: unknown) => void
}

async function apiPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  return res.json()
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return undefined
}

function num(item: Record<string, unknown>, key: string) {
  const v = item[key]
  return typeof v === "number" ? v : undefined
}

function checkCode(raw: unknown): Record<string, unknown> {
  const data = record(raw)
  if (!data) throw new Error("接口响应不是对象")
  const code = str(data.returnCode)
  if (code !== "SUC0000") throw new Error(str(data.errorMsg) || str(data.errMsg) || "接口返回失败")
  return data
}

function formatDetail(taskId: string, item: Record<string, unknown>): string {
  const taskType = num(item, "taskType")
  const taskStatus = num(item, "status")
  return JSON.stringify(
    {
      success: true,
      message: "查询任务详情成功",
      data: {
        taskId,
        taskType: item.taskType,
        taskTypeDesc: taskType === undefined ? "未知" : (TYPES[taskType] ?? "未知"),
        taskSource: item.taskSource,
        productCode: item.productCode,
        execSuiteName: item.name,
        status: item.status,
        statusDesc: taskStatus === undefined ? "未知" : (STATUS[taskStatus] ?? "未知"),
        creator: item.creator,
        createTime: item.createTime,
        startTime: item.startTime,
        finishTime: item.finishTime,
        caseStats: {
          total: item.total,
          success: item.success,
          fail: item.fail,
          allCaseSize: item.allCaseSize,
        },
        codeInfo: {
          giteeAddress: item.giteeAddress || null,
          codeBranch: item.codeBranch || null,
          scriptDirPath: item.scriptDirPath || "",
        },
      },
    },
    null,
    2,
  )
}

// ── Bridge helpers ──────────────────────────────────────────────────────────

function makeMessages(opts: TaskRunnerOpts) {
  const now = Date.now()
  const userMsgID = opts.userMessageID ?? uid()
  const asstMsgID = uid()

  opts.post({
    type: "messageCreated",
    message: {
      id: userMsgID,
      sessionID: opts.sessionID,
      role: "user",
      createdAt: new Date(now).toISOString(),
      time: { created: now },
      parts: [{ type: "text", id: uid(), messageID: userMsgID, text: opts.userText }],
    },
  })
  opts.post({
    type: "messageCreated",
    message: {
      id: asstMsgID,
      sessionID: opts.sessionID,
      role: "assistant",
      parentID: userMsgID,
      createdAt: new Date(now + 1).toISOString(),
      time: { created: now + 1 },
    },
  })
  opts.post({ type: "sessionStatus", sessionID: opts.sessionID, status: "busy" })

  return { userMsgID, asstMsgID }
}

function postText(opts: TaskRunnerOpts, asstMsgID: string, text: string) {
  opts.post({
    type: "partUpdated",
    sessionID: opts.sessionID,
    messageID: asstMsgID,
    part: { type: "text", id: uid(), messageID: asstMsgID, text },
  })
}

function postToolResult(opts: TaskRunnerOpts, asstMsgID: string, title: string, output: string) {
  opts.post({
    type: "partUpdated",
    sessionID: opts.sessionID,
    messageID: asstMsgID,
    part: {
      type: "tool",
      id: uid(),
      messageID: asstMsgID,
      tool: "task-query",
      state: {
        status: "completed",
        input: { title },
        output,
        title,
      },
    },
  })
}

function finish(opts: TaskRunnerOpts, asstMsgID: string, ok: boolean) {
  const now = Date.now()
  opts.post({
    type: "messageCreated",
    message: {
      id: asstMsgID,
      sessionID: opts.sessionID,
      role: "assistant",
      createdAt: new Date(now).toISOString(),
      time: { created: now, completed: now },
      finish: ok ? "stop" : "error",
    },
  })
  opts.post({ type: "sessionStatus", sessionID: opts.sessionID, status: "idle" })
}

// ── Query implementation ────────────────────────────────────────────────────

async function runQuery(opts: TaskRunnerOpts, asstMsgID: string): Promise<void> {
  const taskId = opts.args[0]?.trim()
  const id = Number(taskId)

  if (!taskId || !Number.isFinite(id)) {
    postText(opts, asstMsgID, "❌ 缺少任务ID，用法：`/task-query <taskId>`")
    return
  }

  const raw = await apiPost(`${EXEC}/exec/task/list?taskType=${TASK_TYPE}`, [id])
  const data = checkCode(raw)

  const list = Array.isArray(data.data) ? data.data : []
  const item = record(list[0])
  if (!item?.id) {
    postText(opts, asstMsgID, `❌ 未找到任务ID为 ${taskId} 的任务详情`)
    return
  }

  postToolResult(opts, asstMsgID, `任务详情`, formatDetail(taskId, item))
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function runTaskCommand(opts: TaskRunnerOpts): Promise<void> {
  const { asstMsgID } = makeMessages(opts)
  let ok = true
  try {
    await runQuery(opts, asstMsgID)
  } catch (err) {
    ok = false
    postText(opts, asstMsgID, `❌ ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    finish(opts, asstMsgID, ok)
  }
}
