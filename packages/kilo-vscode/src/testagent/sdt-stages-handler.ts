// testagent_change - new file
/**
 * 处理 webview 发起的阶段列表查询请求（/sdt-run 下拉选择面板用）
 *
 * webview 的 useSdtStages hook 检测到 /sdt-run 文本后，
 * 通过 requestStages 消息请求阶段列表。
 * 本模块执行 testflow stages CLI 并解析 JSON 结果。
 */

import { exec } from "../util/process"
import * as path from "path"

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface StagesHandlerContext {
  getWorkspaceDirectory(sessionId?: string): string
  postMessage(msg: unknown): void
}

export interface StagesResultError {
  code: "workspace-unavailable" | "default-task-missing" | "task-not-found" | "config-invalid" | "command-failed"
  message: string
  detail?: string
}

function normalizeStagesError(error: unknown): StagesResultError {
  const detail = error instanceof Error ? error.message : String(error)
  const normalized = detail.toLowerCase()

  if (normalized.includes("default") && normalized.includes("task")) {
    return {
      code: "default-task-missing",
      message: "当前工作区没有设置默认任务",
      detail: "请先使用 /sdt-switch 选择默认任务。",
    }
  }

  if (normalized.includes("not found") || normalized.includes("不存在")) {
    return {
      code: "task-not-found",
      message: "当前任务不存在",
      detail,
    }
  }

  if (normalized.includes("config") || normalized.includes("yaml") || normalized.includes("配置")) {
    return {
      code: "config-invalid",
      message: "任务配置无效",
      detail,
    }
  }

  return {
    code: "command-failed",
    message: "阶段列表查询失败",
    detail,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) return ""
  const stdout = typeof error.stdout === "string" ? error.stdout : ""
  const stderr = typeof error.stderr === "string" ? error.stderr : ""
  return [stdout, stderr].filter(Boolean).join("\n")
}

function parseCommandError(output: string): StagesResultError | undefined {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed) || parsed.type !== "result" || parsed.kind !== "error") continue
      const detail = typeof parsed.error === "string" ? parsed.error : "阶段命令返回错误"
      return normalizeStagesError(new Error(detail))
    } catch {
      // 忽略非 JSON 行，继续查找 CLI 的结构化错误结果
    }
  }
  return undefined
}

function postStagesError(ctx: StagesHandlerContext, requestId: string, error: StagesResultError): void {
  ctx.postMessage({
    type: "stagesResult",
    ok: false,
    stages: [],
    taskName: "",
    requestId,
    error,
  })
}

// ---------------------------------------------------------------------------
// handleRequestStages
// ---------------------------------------------------------------------------

/**
 * 查询当前任务的所有阶段列表并返回给 webview
 */
export async function handleRequestStages(
  ctx: StagesHandlerContext,
  message: { requestId: string; sessionID?: string },
): Promise<void> {
  const dir = ctx.getWorkspaceDirectory(message.sessionID)
  if (!dir) {
    postStagesError(ctx, message.requestId, {
      code: "workspace-unavailable",
      message: "无法确定当前工作区",
      detail: "请打开一个工作区后重试。",
    })
    return
  }

  // 定位 bundled testflow binary
  const extDir = path.resolve(__dirname, "..")
  const testflowBin = path.join(extDir, "bin", process.platform === "win32" ? "testflow.exe" : "testflow")
  const testflowResDir = path.join(extDir, "bin", "testflow-res")

  try {
    const { stdout } = await exec(testflowBin, ["stages", "--dir", dir], {
      env: { ...process.env, KILO_INTEGRATION: "1", _TESTFLOW_RESOURCES_DIR: testflowResDir },
    })

    // 从 stdout 中解析 JSON result 行
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === "result" && parsed.kind === "stages") {
          ctx.postMessage({
            type: "stagesResult",
            ok: true,
            stages: parsed.stages ?? [],
            taskName: parsed.taskName ?? "",
            requestId: message.requestId,
          })
          return
        }
      } catch {
        // 忽略非 JSON 行（customOra 的终端输出）
      }
    }

    const commandError = parseCommandError(stdout)
    if (commandError) {
      postStagesError(ctx, message.requestId, commandError)
      return
    }

    // 未找到 result 事件
    postStagesError(ctx, message.requestId, {
      code: "command-failed",
      message: "阶段列表查询没有返回有效结果",
      detail: "请重试；如果问题持续，请检查 TestFlow 配置。",
    })
  } catch (err) {
    const outputError = parseCommandError(getErrorOutput(err))
    const error = outputError ?? normalizeStagesError(err)
    console.error("[TestAgent] 查询阶段列表失败:", error.detail)
    postStagesError(ctx, message.requestId, error)
  }
}
