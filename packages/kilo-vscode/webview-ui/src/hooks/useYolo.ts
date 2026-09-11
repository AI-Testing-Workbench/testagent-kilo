// testagent_change - new file
/**
 * Hook: YOLO 模式状态与切换（全局开关）
 *
 * 语义（用户要求）：
 * - 全局开关：开启后【所有会话】均采用 YOLO 模式，与当前会话无关
 *   ——即使没有活动会话（还没发消息的新建页面），也可以切换
 * - 生命周期：进程级，VS Code 重启后重置；只有手动关闭才退出
 *
 * 状态同步：
 * - 乐观更新：点击立即更新 UI，不等后端
 * - 监听 yoloStatus 回包校正（extension 回推）
 * - webview 重挂载 / 切换会话时向后端查询真实状态恢复
 * - 3s 兜底对账（回包丢失时主动查询）
 */
import { createSignal, createEffect, on, onCleanup } from "solid-js"
import type { ExtensionMessage } from "../types/messages"
import { useVSCode } from "../context/vscode"
import { useSession } from "../context/session"

export interface YoloState {
  /** YOLO 全局开关是否开启 */
  enabled: () => boolean
  /** 切换请求是否进行中 */
  busy: () => boolean
  /** 切换 YOLO 开关（乐观更新，后端回包校正） */
  toggle: (next: boolean) => void
}

export function useYolo(vscode?: ReturnType<typeof useVSCode>, session?: ReturnType<typeof useSession>): YoloState {
  const api = vscode ?? useVSCode()
  const ctx = session ?? useSession()
  const [yolo, setYolo] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let counter = 0

  // 监听 extension 回推的 YOLO 状态（toggle 确认 / 查询结果），收到即校正并解除 busy
  const unsubscribe = api.onMessage((message: ExtensionMessage) => {
    if (message.type !== "yoloStatus") return
    if (message.ok) {
      setYolo(message.enabled)
      setBusy(false)
    }
  })
  onCleanup(unsubscribe)

  // webview 重挂载时向后端查询当前状态（后端为单一事实源，
  // extension host 内存优先，见 KiloProvider.handleYoloStatus）
  createEffect(
    on(
      () => ctx.currentSessionID(),
      (id) => {
        if (!id) return
        counter++
        api.postMessage({ type: "requestYoloStatus", requestId: `yolo-status-${counter}` })
      },
    ),
  )

  const toggle = (next: boolean) => {
    if (busy()) return
    setBusy(true)
    // 乐观更新，后端回包会校正
    setYolo(next)
    api.postMessage({ type: "requestYoloToggle", enabled: next })
    // 兜底：3s 后若后端仍未回推确认，主动查询一次并对账
    setTimeout(() => {
      if (!busy()) return
      setBusy(false)
      counter++
      api.postMessage({ type: "requestYoloStatus", requestId: `yolo-status-${counter}` })
    }, 3000)
  }

  return {
    enabled: yolo,
    busy,
    toggle,
  }
}
