/**
 * WorkingIndicator component
 * Shows a spinner, status text, and elapsed time counter while the agent is active.
 * Matches the v1.0.25 working indicator UX.
 */

import { type Component, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Button } from "@kilocode/kilo-ui/button"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"

function ThinkingAvatar() {
  return (
    <svg
      class="thinking-avatar"
      viewBox="-4 -4 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="ta-rg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4fc3f7" />
          <stop offset="50%" stop-color="#2979ff" />
          <stop offset="100%" stop-color="#69f0ae" />
        </linearGradient>
        <filter id="ta-glow">
          <feGaussianBlur stdDeviation="0.8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="12" cy="12" r="12" fill="#e8f4ff" />
      <circle class="ta-ring-bg" cx="12" cy="12" r="12.75" fill="none" stroke="url(#ta-rg)" stroke-width="3" style="filter:url(#ta-glow)" />
      <circle class="ta-ring" cx="12" cy="12" r="12.75" fill="none" stroke="url(#ta-rg)" stroke-width="1.5" style="filter:url(#ta-glow)" />
      <g class="ta-eyes">
        <ellipse cx="9" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
        <ellipse cx="15" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
      </g>
    </svg>
  )
}

export const WorkingIndicator: Component = () => {
  const session = useSession()
  const language = useLanguage()
  const vscode = useVSCode()

  const [elapsed, setElapsed] = createSignal(0)
  const [retryCountdown, setRetryCountdown] = createSignal(0)

  createEffect(() => {
    const since = session.busySince()
    const status = session.status()

    if (status === "idle" || !since) {
      setElapsed(0)
      return
    }

    setElapsed(Math.floor((Date.now() - since) / 1000))

    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - since) / 1000))
    }, 1000)

    onCleanup(() => clearInterval(id))
  })

  createEffect(() => {
    const info = session.statusInfo()
    if (info.type !== "retry") {
      setRetryCountdown(0)
      return
    }

    const target = info.next
    setRetryCountdown(Math.max(0, Math.ceil((target - Date.now()) / 1000)))

    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000))
      setRetryCountdown(remaining)
      if (remaining <= 0) clearInterval(id)
    }, 1000)

    onCleanup(() => clearInterval(id))
  })

  const statusText = () => {
    const info = session.statusInfo()
    if (info.type === "retry") {
      const countdown = retryCountdown()
      const retryMsg = info.message || language.t("session.status.retry")
      return countdown > 0 ? `${retryMsg} (${countdown}s)` : retryMsg
    }
    if (info.type === "offline") {
      return info.message || language.t("session.status.offline")
    }
    return session.statusText() ?? language.t("ui.sessionTurn.status.thinking")
  }

  const formatElapsed = () => {
    const s = elapsed()
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const rem = s % 60
    return `${m}m ${rem}s`
  }

  const blocked = () => {
    const id = session.currentSessionID()
    const perms = session
      .permissions()
      .filter((p) => p.sessionID === id && !(p.tool && ["todowrite", "todoread"].includes(p.toolName)))
    const questions = session.questions().filter((q) => q.sessionID === id)
    const suggestions = session.suggestions().filter((s) => s.sessionID === id)
    return perms.length > 0 || questions.length > 0 || suggestions.length > 0
  }

  const isRetrying = () => session.statusInfo().type === "retry"

  const handleCancelRetry = () => {
    const sid = session.currentSessionID()
    if (sid) {
      vscode.postMessage({ type: "abort", sessionID: sid })
    }
  }

  return (
    <Show when={session.status() !== "idle" && !blocked()}>
      <div class="working-indicator">
        <ThinkingAvatar />
        <span class="working-text">{statusText()}</span>
        <Show when={elapsed() > 0}>
          <span class="working-elapsed">{formatElapsed()}</span>
        </Show>
        <Show when={isRetrying()}>
          <Button
            variant="secondary"
            size="small"
            onClick={handleCancelRetry}
            class="working-cancel"
            style={{ "font-weight": "600", color: "var(--vscode-errorForeground, #f85149)" }}
          >
            {language.t("ui.sessionTurn.cancel") || "Cancel"}
          </Button>
        </Show>
      </div>
    </Show>
  )
}
