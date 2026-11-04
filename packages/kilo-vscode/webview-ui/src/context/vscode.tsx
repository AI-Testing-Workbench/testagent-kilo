/**
 * VS Code API context provider
 * Provides access to the VS Code webview API for posting messages
 */

import { createContext, useContext, onCleanup, ParentComponent } from "solid-js"
import type { VSCodeAPI, WebviewMessage, ExtensionMessage } from "../types/messages"
import { enabled as latencyEnabled, markReceive, attachStatsSender } from "../utils/latency-probe" // testagent_change - 链路探针

// Get the VS Code API (only available in webview context)
let vscodeApi: VSCodeAPI | undefined

export function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    // In VS Code webview, acquireVsCodeApi is available globally
    if (typeof acquireVsCodeApi === "function") {
      vscodeApi = acquireVsCodeApi()
    } else {
      // Mock for development/testing outside VS Code
      console.warn("[testagent] Running outside VS Code, using mock API")
      vscodeApi = {
        postMessage: (msg) => console.log("[testagent] Mock postMessage:", msg),
        getState: () => undefined,
        setState: () => {},
      }
    }
  }
  return vscodeApi
}

// Context value type
interface VSCodeContextValue {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
  getState: <T>() => T | undefined
  setState: <T>(state: T) => void
}

const VSCodeContext = createContext<VSCodeContextValue>()

export const VSCodeProvider: ParentComponent = (props) => {
  const api = getVSCodeAPI()
  const handlers = new Set<(message: ExtensionMessage) => void>()

  // Listen for messages from the extension
  const messageListener = (event: MessageEvent) => {
    const message = event.data as ExtensionMessage
    // testagent_change start - 链路探针⑥: webview 收到扩展消息
    if (latencyEnabled()) {
      const msg = message as {
        type: string
        sessionID?: string
        messageID?: string
        part?: { id?: string; messageID?: string }
        message?: { id?: string }
        sentAt?: number
      }
      markReceive({
        sessionID: msg.sessionID,
        messageID: msg.messageID ?? msg.part?.messageID ?? msg.message?.id,
        partID: msg.part?.id,
        type: msg.type,
        sentAt: msg.sentAt,
      })
    }
    // testagent_change end
    handlers.forEach((handler) => handler(message))
  }

  window.addEventListener("message", messageListener)

  // testagent_change start - 渲染汇总回传扩展宿主,由扩展写入文件
  attachStatsSender((payload) => {
    api.postMessage({
      type: "perfReport",
      windowMs: 5000,
      summary: payload.rows.map((r) => `${r.name} ${r.count}次 总${r.total}ms 均${r.avg}ms 峰${r.max}ms`).join(" | "),
      counters: Object.fromEntries(payload.rows.map((r) => [r.name, r.total])),
    })
  })
  // testagent_change end

  onCleanup(() => {
    window.removeEventListener("message", messageListener)
    handlers.clear()
  })

  const value: VSCodeContextValue = {
    postMessage: (message: WebviewMessage) => {
      api.postMessage(message)
    },
    onMessage: (handler: (message: ExtensionMessage) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    getState: <T,>() => api.getState() as T | undefined,
    setState: <T,>(state: T) => api.setState(state),
  }

  return <VSCodeContext.Provider value={value}>{props.children}</VSCodeContext.Provider>
}

export function useVSCode(): VSCodeContextValue {
  const context = useContext(VSCodeContext)
  if (!context) {
    throw new Error("useVSCode must be used within a VSCodeProvider")
  }
  return context
}
