// testagent_change - new file
/**
 * 白屏自诊断:把 webview 内的未捕获异常转发到扩展宿主日志,
 * 即使页面随后重载清空了 webview DevTools,错误也已持久化在
 * "Output → 扩展" 里(前缀 [TestAgent] ❌ webview crash)。
 */
import { getVSCodeAPI } from "../context/vscode"

let sent = 0

// 规范内的良性告警:ResizeObserver 回调改变布局超出单帧通知上限。
// 虚拟化行测量 + 吸底滚动共存时必然出现,不影响功能,不算崩溃,不上报。
const benign = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/

function report(source: string, detail: unknown) {
  const err = detail instanceof Error ? detail : new Error(String(detail))
  if (benign.test(err.message)) return
  if (sent++ > 5) return
  getVSCodeAPI().postMessage({ type: "webviewCrash", source, message: err.message, stack: err.stack })
}

window.addEventListener("error", (e) => report("error", e.error ?? e.message))
window.addEventListener("unhandledrejection", (e) => report("rejection", e.reason))

export function reload() {
  getVSCodeAPI().postMessage({ type: "reloadWebview" })
}
