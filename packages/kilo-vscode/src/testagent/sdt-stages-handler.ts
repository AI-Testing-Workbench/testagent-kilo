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
    ctx.postMessage({ type: "stagesResult", stages: [], taskName: "", requestId: message.requestId })
    return
  }

  // 定位 bundled testflow binary
  const extDir = path.resolve(__dirname, '..')
  const testflowBin = path.join(extDir, 'bin', process.platform === 'win32' ? 'testflow.exe' : 'testflow')
  const testflowResDir = path.join(extDir, 'bin', 'testflow-res')

  try {
    const { stdout } = await exec(testflowBin, ['stages', '--dir', dir], {
      env: { ...process.env, KILO_INTEGRATION: '1', _TESTFLOW_RESOURCES_DIR: testflowResDir },
    })

    // 从 stdout 中解析 JSON result 行
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === 'result' && parsed.kind === 'stages') {
          ctx.postMessage({
            type: 'stagesResult',
            stages: parsed.stages ?? [],
            taskName: parsed.taskName ?? '',
            requestId: message.requestId,
          })
          return
        }
      } catch {
        // 忽略非 JSON 行（customOra 的终端输出）
      }
    }

    // 未找到 result 事件
    ctx.postMessage({ type: 'stagesResult', stages: [], taskName: '', requestId: message.requestId })
  } catch (err) {
    console.error('[TestAgent] 查询阶段列表失败:', err)
    ctx.postMessage({ type: 'stagesResult', stages: [], taskName: '', requestId: message.requestId })
  }
}