/* @refresh reload */
import "@kilocode/kilo-ui/styles"
import "./utils/beacon" // testagent_change - 崩溃转发监听必须先于 App 模块执行
import { ErrorBoundary, type Component } from "solid-js"
import { render } from "solid-js/web"
import App from "./App"
import { reload } from "./utils/beacon"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

// testagent_change start - 渲染兜底:崩溃时显示错误卡片而不是白屏
const Crash: Component<{ error: Error }> = (props) => (
  <div style={{ padding: "16px", "font-size": "12px" }}>
    <p style={{ color: "var(--error-base, #f14c4c)", "font-weight": "600" }}>TestAgent 界面崩溃</p>
    <p>{props.error.message}</p>
    <pre style={{ "white-space": "pre-wrap", opacity: 0.7, "max-height": "40vh", overflow: "auto" }}>
      {props.error.stack}
    </pre>
    <button style={{ padding: "4px 12px", cursor: "pointer" }} onClick={reload}>
      重新加载界面
    </button>
  </div>
)
// testagent_change end

render(
  () => (
    <ErrorBoundary fallback={(error) => <Crash error={error} />}>
      <App />
    </ErrorBoundary>
  ),
  root,
)
