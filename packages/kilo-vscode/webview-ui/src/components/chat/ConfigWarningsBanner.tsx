/**
 * ConfigWarningsBanner
 * Shown above the chat input when there are config file warnings.
 * Does not block CLI usage — the user can dismiss it.
 */

import { Component, createSignal, Show } from "solid-js"
import { useServer } from "../../context/server"

export const ConfigWarningsBanner: Component = () => {
  const server = useServer()
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
