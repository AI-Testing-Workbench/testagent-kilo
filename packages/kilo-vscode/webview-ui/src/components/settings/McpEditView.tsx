import { Component, Show, createMemo, createSignal, createEffect, For, onCleanup } from "solid-js"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"

import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import type { McpConfig } from "../../types/messages"
import SettingsRow from "./SettingsRow"

interface Props {
  name: string
  onBack: () => void
  onRemove: (name: string) => void
}

const DEBOUNCE_MS = 400

const formatTimeoutSeconds = (value: number | undefined) => {
  if (value == null) return ""
  return String(value)
}

const parseTimeoutSeconds = (value: string) => {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return undefined
  return Math.round(num)
}

const McpEditView: Component<Props> = (props) => {
  const language = useLanguage()
  const { config, updateConfig } = useConfig()

  const cfg = createMemo<McpConfig>(() => config().mcp?.[props.name] ?? {})

  const [envKey, setEnvKey] = createSignal("")
  const [envVal, setEnvVal] = createSignal("")
  const [headerKey, setHeaderKey] = createSignal("")
  const [headerVal, setHeaderVal] = createSignal("")

  // Local signals for debounced fields — updates config only after user stops typing
  const [timeoutText, setTimeoutText] = createSignal(formatTimeoutSeconds(cfg().timeout))

  createEffect(() => {
    const text = timeoutText()
    const currentVal = cfg().timeout
    const newVal = parseTimeoutSeconds(text)

    // Skip if the value hasn't changed from what's already in config
    if (newVal === currentVal || (newVal === undefined && currentVal === undefined)) return

    const timer = setTimeout(() => {
      update({ timeout: newVal })
    }, DEBOUNCE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  const update = (partial: Partial<McpConfig>) => {
    const existing = config().mcp ?? {}
    const current = existing[props.name] ?? {}
    updateConfig({
      mcp: { ...existing, [props.name]: { ...current, ...partial } },
    })
  }

  const transport = () => cfg().type ?? (cfg().url ? "remote" : cfg().command ? "local" : "remote")

  const urlEmpty = () => transport() === "remote" && !cfg().url?.trim()

  const cmd = () => {
    const c = cfg().command
    if (Array.isArray(c)) return c[0] ?? ""
    return c ?? ""
  }

  const args = () => {
    const c = cfg().command
    if (Array.isArray(c)) return c.slice(1).join("\n")
    return ""
  }

  const env = createMemo(() => Object.entries(cfg().environment ?? cfg().env ?? {}).filter(([, v]) => v != null))
  const headers = createMemo(() => Object.entries(cfg().headers ?? {}).filter(([, v]) => v != null))

  const addEnv = () => {
    const key = envKey().trim()
    const val = envVal().trim()
    if (!key) return
    const existing = cfg().environment ?? cfg().env ?? {}
    update({ environment: { ...existing, [key]: val } })
    setEnvKey("")
    setEnvVal("")
  }

  const removeEnv = (key: string) => {
    const existing = { ...(cfg().environment ?? cfg().env ?? {}) }
    existing[key] = null as unknown as string
    update({ environment: existing })
  }

  const addHeader = () => {
    const key = headerKey().trim()
    const val = headerVal().trim()
    if (!key) return
    const existing = cfg().headers ?? {}
    update({ headers: { ...existing, [key]: val } })
    setHeaderKey("")
    setHeaderVal("")
  }

  const removeHeader = (key: string) => {
    const existing = { ...(cfg().headers ?? {}) }
    existing[key] = null as unknown as string
    update({ headers: existing })
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "16px",
        }}
      >
        <div style={{ display: "flex", "align-items": "center" }}>
          <IconButton size="small" variant="ghost" icon="arrow-left" onClick={props.onBack} />
          <span style={{ "font-weight": "600", "font-size": "14px", "margin-left": "8px" }}>
            {language.t("settings.agentBehaviour.editMcp")} — {props.name}
          </span>
        </div>
        <IconButton size="small" variant="ghost" icon="close" onClick={() => props.onRemove(props.name)} />
      </div>

      {/* Transport info */}
      <Card style={{ "margin-bottom": "12px" }}>
        <div
          style={{
            "font-size": "12px",
            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
            padding: "4px 0",
          }}
        >
          {transport() === "local"
            ? language.t("settings.agentBehaviour.editMcp.transportLocal")
            : language.t("settings.agentBehaviour.editMcp.transportRemote")}
        </div>
      </Card>

      {/* Command / URL */}
      <Show when={transport() === "local"}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.addMcp.command")}
          </div>
          <TextField
            value={cmd()}
            placeholder={language.t("settings.agentBehaviour.addMcp.command.placeholder")}
            onChange={(val) => {
              const existing = cfg().command
              const rest = Array.isArray(existing) ? existing.slice(1) : []
              update({ command: [val.trim(), ...rest] })
            }}
          />
        </Card>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "4px" }}>
            {language.t("settings.agentBehaviour.addMcp.args")}
          </div>
          <div data-slot="settings-row-label-subtitle" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.addMcp.args.help")}
          </div>
          <TextField
            value={args()}
            placeholder={language.t("settings.agentBehaviour.addMcp.args.placeholder")}
            multiline
            onChange={(val) => {
              const parts = val.split(/\n/).filter(Boolean)
              update({ command: [cmd(), ...parts] })
            }}
          />
        </Card>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.editMcp.timeout")}
          </div>
          <TextField
            value={timeoutText()}
            placeholder={language.t("settings.agentBehaviour.editMcp.timeout.placeholder")}
            onChange={(val) => setTimeoutText(val)}
          />
        </Card>
      </Show>

      {/* Timeout and Headers for remote */}
      <Show when={transport() === "remote"}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.editMcp.timeout")}
          </div>
          <TextField
            value={timeoutText()}
            placeholder={language.t("settings.agentBehaviour.editMcp.timeout.placeholder")}
            onChange={(val) => setTimeoutText(val)}
          />
        </Card>

        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "4px" }}>
            {language.t("settings.agentBehaviour.editMcp.headers")}
          </div>
          <div data-slot="settings-row-label-subtitle" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.editMcp.headers.help")}
          </div>

          <div
            style={{
              display: "flex",
              gap: "8px",
              "align-items": "center",
              padding: "8px 0",
              "border-bottom": headers().length > 0 ? "1px solid var(--border-weak-base)" : "none",
            }}
          >
            <div style={{ flex: 1 }}>
              <TextField value={headerKey()} placeholder="Header-Name" onChange={(val) => setHeaderKey(val)} />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                value={headerVal()}
                placeholder="value"
                onChange={(val) => setHeaderVal(val)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") addHeader()
                }}
              />
            </div>
            <Button variant="secondary" onClick={addHeader}>
              {language.t("common.add")}
            </Button>
          </div>

          <For each={headers()}>
            {([key, val], index) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "6px 0",
                  "border-bottom": index() < headers().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                }}
              >
                <span
                  style={{
                    "font-family": "var(--vscode-editor-font-family, monospace)",
                    "font-size": "12px",
                  }}
                >
                  {key}: {val}
                </span>
                <IconButton size="small" variant="ghost" icon="close" onClick={() => removeHeader(key)} />
              </div>
            )}
          </For>
        </Card>
      </Show>

      <Show when={transport() === "remote"}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.addMcp.url")}
          </div>
          <TextField
            value={cfg().url ?? ""}
            placeholder={language.t("settings.agentBehaviour.addMcp.url.placeholder")}
            onChange={(val) => update({ url: val.trim() || undefined })}
          />
          <Show when={urlEmpty()}>
            <div style={{ "font-size": "12px", color: "var(--vscode-errorForeground)", "margin-top": "4px" }}>
              {language.t("settings.agentBehaviour.addMcp.url.required")}
            </div>
          </Show>
        </Card>
      </Show>

      {/* Environment variables (local servers only) */}
      <Show when={transport() === "local"}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "4px" }}>
            {language.t("settings.agentBehaviour.editMcp.env")}
          </div>
          <div data-slot="settings-row-label-subtitle" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.editMcp.env.help")}
          </div>

          <div
            style={{
              display: "flex",
              gap: "8px",
              "align-items": "center",
              padding: "8px 0",
              "border-bottom": env().length > 0 ? "1px solid var(--border-weak-base)" : "none",
            }}
          >
            <div style={{ flex: 1 }}>
              <TextField value={envKey()} placeholder="KEY" onChange={(val) => setEnvKey(val)} />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                value={envVal()}
                placeholder="value"
                onChange={(val) => setEnvVal(val)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Enter") addEnv()
                }}
              />
            </div>
            <Button variant="secondary" onClick={addEnv}>
              {language.t("common.add")}
            </Button>
          </div>

          <For each={env()}>
            {([key, val], index) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "6px 0",
                  "border-bottom": index() < env().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                }}
              >
                <span
                  style={{
                    "font-family": "var(--vscode-editor-font-family, monospace)",
                    "font-size": "12px",
                  }}
                >
                  {key}={val}
                </span>
                <IconButton size="small" variant="ghost" icon="close" onClick={() => removeEnv(key)} />
              </div>
            )}
          </For>
        </Card>
      </Show>

      <div style={{ display: "flex", "justify-content": "flex-end" }}>
        <Button variant="ghost" onClick={props.onBack} disabled={urlEmpty()}>
          {language.t("settings.agentBehaviour.editMode.back")}
        </Button>
      </div>
    </div>
  )
}

export default McpEditView
