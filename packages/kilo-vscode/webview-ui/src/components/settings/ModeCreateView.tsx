import { Component, Show, createSignal } from "solid-js"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Select } from "@kilocode/kilo-ui/select"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"

import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import type { AgentConfig } from "../../types/messages"
import SettingsRow from "./SettingsRow"

interface Props {
  /** Names already taken (used for uniqueness validation). */
  taken: string[]
  onBack: () => void
}

type Mode = "primary" | "subagent" | "all"
type Scope = "global" | "project"
const modes: Mode[] = ["primary", "subagent", "all"]
const modeDescriptions: Record<Mode, string> = {
  primary: "此代理显示在 Agent 切换栏中，用户可直接选择使用。适用于通用任务。",
  subagent: "此代理不会显示在切换栏中，只能由其他 Agent 通过 @ 语法调用。适用于后台工具类代理。",
  all: "此代理既显示在切换栏中供用户选择，也可以被其他 Agent 调用。",
}
const scopes: Scope[] = ["global", "project"]
const scopeLabels: Record<Scope, string> = {
  global: "全局配置",
  project: "项目配置",
}
const scopeDescriptions: Record<Scope, string> = {
  global: "保存到全局配置文件（~/.config/testagent/testagent.jsonc），所有项目共享。",
  project: "保存到当前项目的配置文件（.testagent/testagent.json），仅当前项目可用。",
}

const ModeCreateView: Component<Props> = (props) => {
  const language = useLanguage()
  const { config, updateConfig } = useConfig()

  const [name, setName] = createSignal("")
  const [mode, setMode] = createSignal<Mode>("primary")
  const [scope, setScope] = createSignal<Scope>("global")
  const [description, setDescription] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [error, setError] = createSignal("")

  const validate = (val: string): string => {
    if (!val.trim()) return language.t("settings.agentBehaviour.createMode.nameRequired")
    if (!/^[a-z][a-z0-9-]*$/.test(val.trim())) return language.t("settings.agentBehaviour.createMode.nameInvalid")
    if (props.taken.includes(val.trim())) return language.t("settings.agentBehaviour.createMode.nameTaken")
    return ""
  }

  const reset = () => {
    setName("")
    setMode("primary")
    setScope("global")
    setDescription("")
    setPrompt("")
    setError("")
  }

  const cancel = () => {
    reset()
    props.onBack()
  }

  const submit = () => {
    const slug = name().trim()
    const msg = validate(slug)
    if (msg) {
      setError(msg)
      return
    }
    const existing = config().agent ?? {}
    const partial: Partial<AgentConfig> = {
      mode: mode(),
      description: description().trim() || undefined,
      prompt: prompt().trim() || undefined,
    }
    updateConfig({
      agent: { ...existing, [slug]: { ...(existing[slug] ?? {}), ...partial } },
    })
    reset()
    props.onBack()
  }

  return (
    <div>
      <div style={{ display: "flex", "align-items": "center", "margin-bottom": "16px" }}>
        <IconButton size="small" variant="ghost" icon="arrow-left" onClick={cancel} />
        <span style={{ "font-weight": "600", "font-size": "14px", "margin-left": "8px" }}>
          {language.t("settings.agentBehaviour.createMode")}
        </span>
      </div>

      {/* Name */}
      <Card data-variant="wide-input" style={{ "margin-bottom": "12px" }}>
        <SettingsRow
          title={language.t("settings.agentBehaviour.createMode.name")}
          description={language.t("settings.agentBehaviour.createMode.name.description")}
          last
        >
          <TextField
            value={name()}
            placeholder={language.t("settings.agentBehaviour.createMode.name.placeholder")}
            onChange={(val) => {
              setName(val)
              setError("")
            }}
          />
          <Show when={error()}>
            <div
              style={{
                "font-size": "11px",
                color: "var(--vscode-errorForeground)",
                "margin-top": "4px",
              }}
            >
              {error()}
            </div>
          </Show>
        </SettingsRow>
      </Card>
      {/* Mode */}
      <Card data-variant="wide-input" style={{ "margin-bottom": "12px" }}>
        <SettingsRow title="代理模式" description="设置该代理模式">
          <Select<Mode>
            options={[...modes]}
            current={mode()}
            value={(val) => val}
            label={(val) => val}
            onSelect={(val) => {
              if (!val) return
              setMode(val)
            }}
            variant="secondary"
            size="small"
          />
          <div
            style={{
              "font-size": "12px",
              color: "var(--vscode-descriptionForeground)",
              "margin-top": "6px",
              "line-height": "1.4",
            }}
          >
            {modeDescriptions[mode()]}
          </div>
        </SettingsRow>
      </Card>

      <Card data-variant="wide-input" style={{ "margin-bottom": "12px" }}>
        <SettingsRow title="代理作用域" description="创建项目级或全局代理" last>
          <Select<Scope>
            options={[...scopes]}
            current={scope()}
            value={(val) => val}
            label={(val) => scopeLabels[val]}
            onSelect={(val) => {
              if (!val) return
              setScope(val)
            }}
            variant="secondary"
            size="small"
          />
          <div
            style={{
              "font-size": "12px",
              color: "var(--vscode-descriptionForeground)",
              "margin-top": "6px",
              "line-height": "1.4",
            }}
          >
            {scopeDescriptions[scope()]}
          </div>
        </SettingsRow>
      </Card>

      {/* Description (full-width) */}
      <Card style={{ "margin-bottom": "12px" }}>
        <div data-slot="settings-row-label-title" style={{ "margin-bottom": "4px" }}>
          {language.t("settings.agentBehaviour.createMode.description")}
        </div>
        <div data-slot="settings-row-label-subtitle" style={{ "margin-bottom": "8px" }}>
          {language.t("settings.agentBehaviour.createMode.description.help")}
        </div>
        <TextField
          value={description()}
          placeholder={language.t("settings.agentBehaviour.createMode.description.placeholder")}
          onChange={(val) => setDescription(val)}
        />
      </Card>

      {/* Prompt (full-width, auto-resizing) */}
      <Card style={{ "margin-bottom": "12px" }}>
        <div data-slot="settings-row-label-title" style={{ "margin-bottom": "4px" }}>
          {language.t("settings.agentBehaviour.createMode.prompt")}
        </div>
        <div data-slot="settings-row-label-subtitle" style={{ "margin-bottom": "8px" }}>
          {language.t("settings.agentBehaviour.createMode.prompt.help")}
        </div>
        <TextField
          value={prompt()}
          placeholder={language.t("settings.agentBehaviour.createMode.prompt.placeholder")}
          multiline
          onChange={(val) => setPrompt(val)}
        />
      </Card>

      <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
        <Button variant="ghost" onClick={cancel}>
          {language.t("settings.agentBehaviour.createMode.cancel")}
        </Button>
        <Button variant="primary" onClick={submit}>
          {language.t("settings.agentBehaviour.createMode.button")}
        </Button>
      </div>
    </div>
  )
}

export default ModeCreateView
