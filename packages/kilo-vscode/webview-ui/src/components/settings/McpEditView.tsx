import { Component, Show, createMemo, createSignal, createEffect, For, onCleanup } from "solid-js"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"

import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import type { McpConfig } from "../../types/messages"
import SettingsRow from "./SettingsRow"

interface Props {
  name: string
  isNew?: boolean
  onBack: () => void
  onRemove: (name: string) => void
  onCreated?: (name: string) => void
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
  const t = language.t
  const { config, updateConfig } = useConfig()
  const session = useSession()
  const busy = () => session.anyBusy()

  // Create-mode state
  const [newName, setNewName] = createSignal("")
  const [createErr, setCreateErr] = createSignal("")

  const existingNames = createMemo(() => Object.keys(config().mcp ?? {}))

  const doCreate = () => {
    if (busy()) return
    const n = newName().trim()
    if (!n) {
      setCreateErr(t("settings.agentBehaviour.addMcpDialog.nameRequired"))
      return
    }
    if (existingNames().includes(n)) {
      setCreateErr(t("settings.agentBehaviour.addMcpDialog.nameTaken"))
      return
    }
    const existing = config().mcp ?? {}
    updateConfig({ mcp: { ...existing, [n]: { type: "remote", url: "" } } })
    props.onCreated?.(n)
  }

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
    if (busy()) return
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
      <Show when={busy()}>
        <div
          style={{
            "font-size": "12px",
            color: "var(--vscode-editorWarning-foreground, #ff9800)",
            "margin-bottom": "12px",
            padding: "6px 10px",
            "border-radius": "4px",
            "background-color": "var(--vscode-editorWarning-background, rgba(255, 152, 0, 0.1))",
            "border": "1px solid var(--vscode-editorWarning-foreground, #ff9800)",
          }}
        >
          {language.t("settings.agentBehaviour.mcpBusyWarning")}
        </div>
      </Show>
      {/* Create mode: name input + create button */}
      <Show when={props.isNew}>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "margin-bottom": "16px",
          }}
        >
          <IconButton size="small" variant="ghost" icon="arrow-left" onClick={props.onBack} />
          <span style={{ "font-weight": "600", "font-size": "14px", "margin-left": "8px" }}>
            {t("settings.agentBehaviour.addMcpDialog.title")}
          </span>
        </div>

        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {t("settings.agentBehaviour.addMcpDialog.name")}
          </div>
          <TextField
            value={newName()}
            placeholder={t("settings.agentBehaviour.addMcpDialog.name.placeholder")}
            onChange={(val) => {
              setNewName(val)
              setCreateErr("")
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") doCreate()
            }}
          />
          <Show when={createErr()}>
            <div style={{ "font-size": "12px", color: "var(--vscode-errorForeground)", "margin-top": "4px" }}>
              {createErr()}
            </div>
          </Show>
        </Card>

        <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
          <Button variant="ghost" onClick={props.onBack}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={doCreate}>
            {t("common.submit")}
          </Button>
        </div>
      </Show>

      {/* Edit mode: normal header + config form */}
      <Show when={!props.isNew}>
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
              {t("settings.agentBehaviour.editMcp")} — {props.name}
            </span>
          </div>
          <IconButton size="small" variant="ghost" icon="close" disabled={busy()} onClick={() => props.onRemove(props.name)} />
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
            {t("settings.agentBehaviour.editMode.back")}
          </Button>
        </div>
      </Show>
    </div>
  )
}

export default McpEditView
