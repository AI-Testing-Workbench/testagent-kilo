/**
 * ConfigWarningsBanner
 * Shown above the chat input when there are config file warnings.
 * Does not block CLI usage — the user can dismiss it.
 */

import { Component, createSignal, Show } from "solid-js"
import { useServer } from "../../context/server"
import { useVSCode } from "../../context/vscode"

export const ConfigWarningsBanner: Component = () => {
  const server = useServer()
  const vscode = useVSCode()
  const [expanded, setExpanded] = createSignal(false)

  return (
    <Show when={server.configWarningsTitle()}>
      <div class="startup-error-banner">
        <div class="startup-error-header" onClick={() => setExpanded((v) => !v)} role="button" aria-expanded={expanded()}>
          <span class={`startup-error-chevron${expanded() ? " startup-error-chevron-expanded" : ""}`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4" /></svg>
          </span>
          <span class="startup-error-title">
            <span class="startup-error-firstline">{server.configWarningsTitle()}</span>
          </span>
          {/* 重启： 重启后端服务，重新加载配置和SSE连接 */}
          <button
            class="startup-error-retry"
            onClick={(e: MouseEvent) => {
              e.stopPropagation()
              server.dismissConfigWarnings()
              vscode.postMessage({ type: "restartServer" })
            }}
            aria-label="重启"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "4px", color: "inherit" }}
          >
            <svg viewBox="0 0 512 512" width="14" height="14" fill="currentColor">
              <path d="M489.797,256c-10.791-0.141-19.924,7.939-21.099,18.667c-9.959,117.754-113.491,205.138-231.245,195.179   S32.315,356.354,42.275,238.6S155.766,33.462,273.52,43.421c50.983,4.312,98.733,26.75,134.592,63.245h-66.603   c-11.782,0-21.333,9.551-21.333,21.333s9.551,21.333,21.333,21.333h88.384c21.874-0.012,39.604-17.742,39.616-39.616V21.333   C469.509,9.551,459.958,0,448.176,0c-11.782,0-21.333,9.551-21.333,21.333v44.331C321.548-28.425,159.915-19.341,65.826,85.954   s-85.005,266.927,20.29,361.016s266.927,85.005,361.016-20.29c36.575-40.931,59.007-92.547,63.977-147.214   c1.096-11.814-7.593-22.279-19.407-23.375C491.069,256.033,490.434,256.002,489.797,256z" />
            </svg>
          </button>
          {/* 关闭： 仅隐藏横幅 */}
          <button
            class="startup-error-retry"
            onClick={(e: MouseEvent) => {
              e.stopPropagation()
              server.dismissConfigWarnings()
            }}
            aria-label="关闭"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "4px", color: "inherit" }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2 2l10 10M12 2l-10 10" />
            </svg>
          </button>

        </div>
        <Show when={expanded()}>
          <pre class="startup-error-details">{server.configWarningsDetail()}</pre>
        </Show>
      </div>
    </Show >
  )
}
