/**
 * SandboxBrowserBanner
 * testagent_change - 沙箱（云端模式）下显示在聊天输入框上方的横幅。
 * 沙箱镜像注入 TESTAGENT_VNC_URL（即 TESTAGENT_ENABLE_CHROME=1 时）才出现，
 * 点击后在 tscode 内置 Simple Browser 中打开容器内的 noVNC 桌面。
 */

import { Component, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"

export const SandboxBrowserBanner: Component = () => {
  const { postMessage, onMessage } = useVSCode()
  const [url, setUrl] = createSignal("")
  const [closed, setClosed] = createSignal(false)

  onMount(() => postMessage({ type: "requestBrowserSettings" }))

  // Subscribe outside onMount to catch early pushes (per AGENTS.md pattern)
  const unsubscribe = onMessage((msg) => {
    if (msg.type === "browserSettingsLoaded") setUrl(msg.settings.vncUrl)
  })
  onCleanup(unsubscribe)

  const open = () => postMessage({ type: "openSandboxBrowser" })

  const close = (e: MouseEvent) => {
    e.stopPropagation()
    setClosed(true)
  }

  return (
    <Show when={!closed() && url()}>
      <div
        class="sandbox-browser-banner"
        role="button"
        tabIndex={0}
        aria-label="打开沙箱浏览器"
        onClick={open}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.target !== e.currentTarget) return
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            open()
          }
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm5.9 7h-2.2a12.5 12.5 0 00-1-3.6A6.5 6.5 0 0113.9 7zM8 1.6c.6.8 1.2 2.2 1.5 5.4h-3C6.8 3.8 7.4 2.4 8 1.6zM1.6 8A6.4 6.4 0 012.1 7h2.2c.2-1.3.5-2.5.9-3.5A6.5 6.5 0 001.6 8zm2.2 1h-2.2a6.5 6.5 0 003.2 3.5c-.4-1-.7-2.2-.9-3.5H3.8zm.5 0h3c-.3 3.1-.9 4.5-1.5 5.4-.6-.9-1.2-2.3-1.5-5.4zm4 0h3c-.3 3.1-.9 4.5-1.5 5.4-.6-.9-1.2-2.3-1.5-5.4zm3.6 0h-2.2c-.1 1.3-.4 2.5-.9 3.5A6.5 6.5 0 0013.9 9h-.2zm-2.2-1h2.2a6.5 6.5 0 00-2.4-3.5c.4 1 .7 2.2.9 3.5h-.7z" />
        </svg>
        <span class="sandbox-browser-banner-text">打开沙箱浏览器</span>
        <button
          class="sandbox-browser-banner-close"
          type="button"
          aria-label="关闭"
          onClick={close}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 2l10 10M12 2l-10 10" />
          </svg>
        </button>
      </div>
    </Show>
  )
}
