import { Component, createSignal, createMemo, createEffect, For, Show, onCleanup } from "solid-js"
import { Select } from "@kilocode/kilo-ui/select"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Switch } from "@kilocode/kilo-ui/switch"

import { useConfig } from "../../context/config"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import type { AgentInfo, PluginSpec, SkillInfo } from "../../types/messages"
import ModeEditView from "./ModeEditView"
import ModeCreateView from "./ModeCreateView"
import McpEditView from "./McpEditView"
import WorkflowsTab from "./agent-behaviour/WorkflowsTab"
import { parseImport, MAX_IMPORT_SIZE } from "./mode-io"
import type { ImportError } from "./mode-io"

type SubtabId = "agents" | "mcpServers" | "rules" | "workflows" | "skills" | "plugins"

interface SubtabConfig {
  id: SubtabId
  labelKey: string
}

const subtabs: SubtabConfig[] = [
  { id: "agents", labelKey: "settings.agentBehaviour.subtab.agents" },
  { id: "mcpServers", labelKey: "settings.agentBehaviour.subtab.mcpServers" },
  { id: "rules", labelKey: "settings.agentBehaviour.subtab.rules" },
  { id: "workflows", labelKey: "settings.agentBehaviour.subtab.workflows" },
  { id: "skills", labelKey: "settings.agentBehaviour.subtab.skills" },
  { id: "plugins", labelKey: "插件" },
]

interface SelectOption {
  value: string
  label: string
}

interface PluginItem {
  spec: PluginSpec
  name: string
  description: string
  path: string
  source?: string
  scope?: "global" | "local"
  options?: Record<string, unknown>
  error?: string
}

import SettingsRow from "./SettingsRow"

// View states for the agents subtab
type AgentView = "list" | "create" | "edit"

const AgentBehaviourTab: Component = () => {
  const language = useLanguage()
  const { config, updateConfig, saveConfig } = useConfig()
  const session = useSession()
  const dialog = useDialog()
  const vscode = useVSCode()
  const [activeSubtab, setActiveSubtab] = createSignal<SubtabId>("agents")
  const [newSkillPath, setNewSkillPath] = createSignal("")
  const [newSkillUrl, setNewSkillUrl] = createSignal("")
  const [newInstruction, setNewInstruction] = createSignal("")
  const [claudeCompat, setClaudeCompat] = createSignal(false)
  const browse = () => vscode.postMessage({ type: "openMarketplacePanel" })

  // Load the VS Code setting for Claude Code compatibility
  vscode.postMessage({ type: "requestClaudeCompatSetting" })
  const unsubClaudeCompat = vscode.onMessage((msg) => {
    if (msg.type === "claudeCompatSettingLoaded") {
      setClaudeCompat(msg.enabled)
    }
  })
  onCleanup(unsubClaudeCompat)

  // Agent view state
  const [agentView, setAgentView] = createSignal<AgentView>("list")
  const [editingAgent, setEditingAgent] = createSignal<string>("")

  // MCP view state
  const [editingMcp, setEditingMcp] = createSignal<string>("")
  const [creatingMcp, setCreatingMcp] = createSignal(false)

  // Fetch skills whenever the skills subtab becomes active
  createEffect(() => {
    if (activeSubtab() === "skills") {
      session.refreshSkills()
    }
  })

  const agentNames = createMemo(() => {
    // Exclude server-side hidden internal modes (compaction, title, summary)
    // from the list. Config-only agents are still added below.
    const names = session
      .allAgents()
      .filter((a) => !a.hidden)
      .map((a) => a.name)
    // Also include any agents from config that might not be in the agent list
    const agents = Object.keys(config().agent ?? {})
    for (const name of agents) {
      if (!names.includes(name)) {
        names.push(name)
      }
    }
    return names.sort()
  })

  // Default-agent picker must only show visible primary agents (not subagents
  // or hidden modes) since the CLI rejects those as default_agent values.
  const defaultAgentOptions = createMemo<SelectOption[]>(() => {
    const visible = session.agents().map((a) => a.name)
    return [
      { value: "", label: language.t("common.default") },
      ...visible.map((name) => ({ value: name, label: name })),
    ]
  })

  const instructions = () => config().instructions ?? []

  const addInstruction = () => {
    const value = newInstruction().trim()
    if (!value) {
      return
    }
    const current = [...instructions()]
    if (!current.includes(value)) {
      current.push(value)
      updateConfig({ instructions: current })
    }
    setNewInstruction("")
  }

  const removeInstruction = (index: number) => {
    const current = [...instructions()]
    current.splice(index, 1)
    updateConfig({ instructions: current })
  }

  const skillPaths = () => config().skills?.paths ?? []
  const skillUrls = () => config().skills?.urls ?? []

  const pluginName = (plugin: PluginSpec) => (Array.isArray(plugin) ? plugin[0] : plugin)
  const pluginOptions = (plugin: PluginSpec) => (Array.isArray(plugin) ? plugin[1] : undefined)
  const pluginKey = (name: string) => {
    if (name.startsWith("file://")) return name.toLowerCase()
    const raw = name.replace(/^npm:/, "")
    if (raw.startsWith("@")) {
      const parts = raw.split("/")
      const pkg = parts[1]?.split("@")[0]
      return pkg ? `${parts[0]}/${pkg}` : raw
    }
    return raw.split("@")[0] || raw
  }
  const sameName = (a: string, b: string) => a === b || pluginKey(a) === pluginKey(b)
  const samePlugin = (a: PluginSpec, b: PluginSpec) => sameName(pluginName(a), pluginName(b))
  const hasStatus = (items: string[], plugin: PluginSpec) => items.some((item) => sameName(pluginName(plugin), item))
  const failedStatus = (plugin: PluginSpec) =>
    config().plugin_status?.failed.find((item) => sameName(pluginName(plugin), item.spec))
  const pluginPath = (plugin: PluginSpec) => {
    const name = pluginName(plugin)
    if (!name.startsWith("file://")) return name
    return decodeURIComponent(name.replace(/^file:\/\//, ""))
  }
  const pluginTitle = (plugin: PluginSpec) => {
    const path = pluginPath(plugin)
    if (!pluginName(plugin).startsWith("file://")) return path
    return (
      path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") || path
    )
  }
  const pluginDescription = (plugin: PluginSpec) => {
    const description = pluginOptions(plugin)?.description
    if (typeof description === "string" && description.trim()) return description
    if (pluginName(plugin).startsWith("file://")) return "本地插件"
    return "NPM 插件"
  }
  const pluginLocation = (plugin: PluginSpec) => {
    const name = pluginName(plugin)
    if (!name.startsWith("file://")) return undefined
    return name
  }
  const pluginItem = (plugin: PluginSpec, origin?: { source: string; scope: "global" | "local" }, error?: string) => ({
    spec: plugin,
    name: pluginTitle(plugin),
    description: pluginDescription(plugin),
    path: pluginPath(plugin),
    source: origin?.source,
    scope: origin?.scope,
    options: pluginOptions(plugin),
    error,
  })

  const plugins = createMemo<PluginItem[]>(() => {
    const origins = config().plugin_origins
    const status = config().plugin_status
    if (!status) return []
    if (origins?.length) {
      const list = origins.filter((origin) => !failedStatus(origin.spec) && hasStatus(status.success, origin.spec))
      return list.map((origin) => pluginItem(origin.spec, origin))
    }

    const list = (config().plugin ?? []).filter((plugin) => !failedStatus(plugin) && hasStatus(status.success, plugin))
    return list.map((plugin) => pluginItem(plugin))
  })

  const failedPlugins = createMemo<PluginItem[]>(() => {
    const failed = config().plugin_status?.failed ?? []
    const origins = config().plugin_origins ?? []
    return failed.map((item) => {
      const origin = origins.find((origin) => sameName(pluginName(origin.spec), item.spec))
      return pluginItem(origin?.spec ?? item.spec, origin, item.error)
    })
  })

  const addSkillPath = () => {
    const value = newSkillPath().trim()
    if (!value) {
      return
    }
    const current = [...skillPaths()]
    if (!current.includes(value)) {
      current.push(value)
      updateConfig({ skills: { ...config().skills, paths: current } })
    }
    setNewSkillPath("")
  }

  const removeSkillPath = (index: number) => {
    const current = [...skillPaths()]
    current.splice(index, 1)
    updateConfig({ skills: { ...config().skills, paths: current } })
  }

  const addSkillUrl = () => {
    const value = newSkillUrl().trim()
    if (!value) {
      return
    }
    const current = [...skillUrls()]
    if (!current.includes(value)) {
      current.push(value)
      updateConfig({ skills: { ...config().skills, urls: current } })
    }
    setNewSkillUrl("")
  }

  const removeSkillUrl = (index: number) => {
    const current = [...skillUrls()]
    current.splice(index, 1)
    updateConfig({ skills: { ...config().skills, urls: current } })
  }

  const confirmRemoveSkill = (skill: SkillInfo) => {
    dialog.show(() => (
      <Dialog title={language.t("settings.agentBehaviour.removeSkill.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("settings.agentBehaviour.removeSkill.confirm", { name: skill.name })}</span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                session.removeSkill(skill.location)
                dialog.close()
              }}
            >
              {language.t("settings.agentBehaviour.removeSkill.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const removePlugin = (plugin: PluginItem) => {
    const current = config().plugin ?? plugins().map((item) => item.spec)
    const origins = config().plugin_origins
    const location = pluginLocation(plugin.spec)
    if (location) {
      vscode.postMessage({ type: "removePlugin", location })
    }
    updateConfig({
      plugin: current.filter((item) => !samePlugin(item, plugin.spec)),
      plugin_origins: origins?.filter((item) => !samePlugin(item.spec, plugin.spec)),
    })
  }

  const confirmRemovePlugin = (plugin: PluginItem) => {
    dialog.show(() => (
      <Dialog title={language.t("common.delete")} fit>
        <div class="dialog-confirm-body">
          <span>
            删除插件 "{plugin.name}" 吗？
            {pluginLocation(plugin.spec)
              ? "这会删除本地插件文件，并从配置中的 plugin 列表移除它。"
              : "这会从配置中的 plugin 列表移除它。"}
          </span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                removePlugin(plugin)
                dialog.close()
              }}
            >
              {language.t("common.delete")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const removableModes = createMemo(() => session.allAgents().filter((a) => !a.native))

  const confirmRemoveMode = (agent: AgentInfo) => {
    dialog.show(() => (
      <Dialog title={language.t("settings.agentBehaviour.removeMode.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("settings.agentBehaviour.removeMode.confirm", { name: agent.name })}</span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                // Delay optimistic removal until after dialog close animation (100ms)
                // to prevent the reactive list re-render from firing click handlers
                // on shifted list items while the dialog overlay is still present.
                setTimeout(() => {
                  session.removeMode(agent.name)
                  // If we were editing this mode, go back to list
                  if (editingAgent() === agent.name) {
                    setAgentView("list")
                    setEditingAgent("")
                  }
                }, 150)
              }}
            >
              {language.t("settings.agentBehaviour.removeMode.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const startEdit = (name: string) => {
    setEditingAgent(name)
    setAgentView("edit")
  }

  const back = () => {
    setAgentView("list")
    setEditingAgent("")
  }

  const [importError, setImportError] = createSignal("")

  const errorKey = (tag: ImportError) => `settings.agentBehaviour.importMode.${tag}` as const

  const importMode = (file: File) => {
    setImportError("")
    if (file.size > MAX_IMPORT_SIZE) {
      setImportError(language.t(errorKey("tooLarge")))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = parseImport(reader.result as string, agentNames())
      if (!result.ok) {
        setImportError(language.t(errorKey(result.error)))
        return
      }
      const existing = config().agent ?? {}
      updateConfig({ agent: { ...existing, [result.name]: result.config } })
      setImportError("")
    }
    reader.readAsText(file)
  }

  const triggerImport = () => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".json"
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) importMode(file)
    }
    input.click()
  }

  const renderAgentsSubtab = () => {
    const view = agentView()
    if (view === "create") return <ModeCreateView taken={agentNames()} onBack={back} />
    if (view === "edit") return <ModeEditView name={editingAgent()} onBack={back} onRemove={confirmRemoveMode} />

    return (
      <div>
        {/* Default agent */}
        <Card style={{ "margin-bottom": "12px" }}>
          <SettingsRow
            title={language.t("settings.agentBehaviour.defaultAgent.title")}
            description={language.t("settings.agentBehaviour.defaultAgent.description")}
            last
          >
            <Select
              options={defaultAgentOptions()}
              current={defaultAgentOptions().find((o) => o.value === (config().default_agent ?? ""))}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(o) => {
                if (!o) return
                const next = o.value || null
                if ((next ?? undefined) === (config().default_agent ?? undefined)) return
                updateConfig({ default_agent: next })
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingsRow>
        </Card>

        {/* Available agents list header + create button */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            "margin-bottom": "8px",
            "margin-top": "16px",
          }}
        >
          <div data-slot="settings-row-label-title">{language.t("settings.agentBehaviour.availableAgents")}</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Button variant="ghost" size="small" onClick={triggerImport}>
              {language.t("settings.agentBehaviour.importMode")}
            </Button>
            <Button variant="secondary" size="small" onClick={() => setAgentView("create")}>
              {language.t("settings.agentBehaviour.createMode")}
            </Button>
          </div>
        </div>

        <Show when={importError()}>
          <div
            style={{
              "font-size": "12px",
              color: "var(--vscode-errorForeground)",
              "margin-bottom": "8px",
            }}
          >
            {importError()}
          </div>
        </Show>

        {/* Agents list - clickable to edit */}
        <Show
          when={agentNames().length > 0}
          fallback={
            <Card style={{ "margin-bottom": "12px" }}>
              <div
                style={{
                  "font-size": "12px",
                  color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                }}
              >
                {language.t("settings.agentBehaviour.noModesFound")}
              </div>
            </Card>
          }
        >
          <Card style={{ "margin-bottom": "12px" }}>
            <For each={agentNames()}>
              {(name, index) => {
                const agent = () => session.allAgents().find((a) => a.name === name)
                const isCustom = () => !agent()?.native
                const agentCfg = () => config().agent?.[name] ?? {}
                const disabled = () => agentCfg().disable ?? false
                const hidden = () => agentCfg().hidden ?? false
                const deprecated = () => agent()?.deprecated ?? false
                return (
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      padding: "8px 4px",
                      "border-bottom": index() < agentNames().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                      "border-radius": "4px",
                      cursor: "pointer",
                      opacity: disabled() ? "0.5" : "1",
                    }}
                    onClick={() => startEdit(name)}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-hover-base, var(--vscode-list-hoverBackground))"
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent"
                    }}
                  >
                    <div style={{ flex: 1, "min-width": 0 }}>
                      <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                        <div style={{ "font-weight": "500", "font-size": "13px" }}>{name}</div>
                        <Show when={isCustom()}>
                          <span
                            style={{
                              "font-size": "10px",
                              padding: "1px 5px",
                              "border-radius": "3px",
                              background: "var(--bg-subtle-base, var(--vscode-badge-background))",
                              color: "var(--text-weak-base, var(--vscode-badge-foreground))",
                            }}
                          >
                            custom
                          </span>
                        </Show>
                        <Show when={(agent()?.mode || config().agent?.[name]) === "subagent"}>
                          <span
                            style={{
                              "font-size": "10px",
                              padding: "1px 5px",
                              "border-radius": "3px",
                              background: "var(--bg-subtle-base, var(--vscode-badge-background))",
                              color: "var(--text-weak-base, var(--vscode-badge-foreground))",
                            }}
                          >
                            {language.t("settings.agentBehaviour.badge.subagent")}
                          </span>
                        </Show>
                        <Show when={hidden()}>
                          <span
                            style={{
                              "font-size": "10px",
                              padding: "1px 5px",
                              "border-radius": "3px",
                              background: "var(--bg-subtle-base, var(--vscode-badge-background))",
                              color: "var(--text-weak-base, var(--vscode-badge-foreground))",
                            }}
                          >
                            {language.t("settings.agentBehaviour.badge.hidden")}
                          </span>
                        </Show>
                        <Show when={disabled()}>
                          <span
                            style={{
                              "font-size": "10px",
                              padding: "1px 5px",
                              "border-radius": "3px",
                              background: "var(--vscode-errorForeground, #f44)",
                              color: "var(--vscode-errorForeground-foreground, #fff)",
                            }}
                          >
                            {language.t("settings.agentBehaviour.badge.disabled")}
                          </span>
                        </Show>
                        <Show when={deprecated()}>
                          <span
                            style={{
                              "font-size": "10px",
                              padding: "1px 5px",
                              "border-radius": "3px",
                              background: "var(--vscode-editorWarning-foreground, #cca700)",
                              color: "var(--vscode-editorWarning-foreground-text, #1e1e1e)",
                            }}
                          >
                            {language.t("settings.agentBehaviour.badge.deprecated")}
                          </span>
                        </Show>
                      </div>
                      <Show when={agent()?.description}>
                        <div
                          style={{
                            "font-size": "11px",
                            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                            "margin-top": "2px",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {agent()!.description}
                        </div>
                      </Show>
                    </div>
                    <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                      <Show when={isCustom()}>
                        <IconButton
                          size="small"
                          variant="ghost"
                          icon="close"
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            const a = agent()
                            if (a) confirmRemoveMode(a)
                          }}
                        />
                      </Show>
                      <IconButton size="small" variant="ghost" icon="chevron-right" />
                    </div>
                  </div>
                )
              }}
            </For>
          </Card>
        </Show>
      </div>
    )
  }

  const confirmRemoveMcp = (name: string) => {
    if (session.anyBusy()) return
    dialog.show(() => (
      <Dialog title={language.t("settings.agentBehaviour.removeMcp.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("settings.agentBehaviour.removeMcp.confirm", { name })}</span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                // Clean up legacy files (kilo/mcp.json, marketplace, etc.)
                session.removeMcp(name)
                // Remove from main config via null sentinel,
                // so deepMerge overrides the draft entry and stripNulls cleans it up.
                updateConfig({ mcp: { ...config().mcp, [name]: null } as any })
                saveConfig()
              }}
            >
              {language.t("settings.agentBehaviour.removeMcp.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const renderMcpSubtab = () => {
    const mcpEntries = createMemo(() => {
      const entries = Object.entries(config().mcp ?? {})
      entries.sort((a, b) => {
        const scopeA = config().mcp_scopes?.[a[0]]
        const scopeB = config().mcp_scopes?.[b[0]]
        if (scopeA === "local" && scopeB !== "local") return -1
        if (scopeA !== "local" && scopeB === "local") return 1
        return 0
      })
      return entries
    })
    const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})

    // Create mode — delegate to McpEditView
    if (creatingMcp()) {
      return (
        <McpEditView
          isNew
          name=""
          onBack={() => setCreatingMcp(false)}
          onRemove={() => {}}
          onCreated={(name) => {
            setCreatingMcp(false)
            setEditingMcp(name)
          }}
        />
      )
    }

    const toggle = (name: string) => {
      setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))
    }

    const statusColor = (name: string) => {
      const s = session.mcpStatus()[name]?.status
      if (s === "connected") return "var(--vscode-testing-iconPassed, #4caf50)"
      if (s === "failed") return "var(--vscode-testing-iconFailed, #f44336)"
      if (s === "needs_auth" || s === "needs_client_registration")
        return "var(--vscode-editorWarning-foreground, #ff9800)"
      if (s === "disabled") return "var(--vscode-disabledForeground, #888)"
      return "var(--vscode-disabledForeground, #888)"
    }

    const statusLabel = (name: string) => {
      const s = session.mcpStatus()[name]?.status
      if (!s) return ""
      const key = {
        connected: "mcp.status.connected",
        failed: "mcp.status.failed",
        needs_auth: "mcp.status.needs_auth",
        disabled: "mcp.status.disabled",
        needs_client_registration: "mcp.status.needs_registration",
      }[s]
      return key ? language.t(key) : s
    }

    const isConnected = (name: string) => session.mcpStatus()[name]?.status === "connected"
    const busy = () => session.anyBusy()

    if (editingMcp()) {
      return (
        <McpEditView
          name={editingMcp()}
          onBack={() => setEditingMcp("")}
          onRemove={(name) => {
            confirmRemoveMcp(name)
            setEditingMcp("")
          }}
        />
      )
    }

    return (
      <div>
        <Show when={busy()}>
          <div
            style={{
              "font-size": "12px",
              color: "var(--vscode-editorWarning-foreground, #ff9800)",
              "margin-bottom": "8px",
              padding: "6px 10px",
              "border-radius": "4px",
              "background-color": "var(--vscode-editorWarning-background, rgba(255, 152, 0, 0.1))",
              "border": "1px solid var(--vscode-editorWarning-foreground, #ff9800)",
            }}
          >
            {language.t("settings.saveBar.warning.one")}
          </div>
        </Show>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "flex-end",
            "margin-bottom": "8px",
          }}
        >
          <Button variant="secondary" size="small" onClick={() => setCreatingMcp(true)} disabled={busy()}>
            {language.t("settings.agentBehaviour.addMcpButton")}
          </Button>
        </div>
        <Show
          when={mcpEntries().length > 0}
          fallback={
            <Card>
              <div
                style={{
                  "font-size": "12px",
                  color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                }}
              >
                {language.t("settings.agentBehaviour.mcpEmpty")}
              </div>
            </Card>
          }
        >
          <Card>
            <For each={mcpEntries()}>
              {([name, mcp], index) => {
                const open = () => expanded()[name] ?? false
                const env = () => Object.entries(mcp.environment ?? mcp.env ?? {})
                const error = () => {
                  const s = session.mcpStatus()[name]
                  if (s?.status === "failed") return s.error
                  if (s?.status === "needs_client_registration") return s.error
                  return undefined
                }
                return (
                  <div
                    style={{
                      "border-bottom": index() < mcpEntries().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                    }}
                  >
                    {/* Header row */}
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "space-between",
                        padding: "8px 0",
                        cursor: busy() ? "default" : "pointer",
                        opacity: busy() ? "0.6" : "1",
                      }}
                      onClick={() => {
                        if (busy()) return
                        toggle(name)
                      }}
                    >
                      <div style={{ display: "flex", "align-items": "center", gap: "6px", flex: 1, "min-width": 0 }}>
                        <IconButton
                          size="small"
                          variant="ghost"
                          icon={open() ? "chevron-down" : "chevron-right"}
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            toggle(name)
                          }}
                        />
                        {/* Status dot */}
                        <div
                          style={{
                            width: "6px",
                            height: "6px",
                            "border-radius": "50%",
                            "background-color": statusColor(name),
                            "flex-shrink": "0",
                          }}
                        />
                        <div style={{ "font-weight": "500" }}>{name}</div>
                        <span
                          title={config().mcp_origins?.[name] ?? undefined}
                          style={{
                            "font-size": "10px",
                            padding: "1px 5px",
                            "border-radius": "3px",
                            "background-color": "var(--bg-subtle-base, var(--vscode-badge-background))",
                            color: "var(--text-weak-base, var(--vscode-badge-foreground))",
                            "flex-shrink": "0",
                          }}
                        >
                          {config().mcp_scopes?.[name] === "local"
                            ? language.t("settings.agentBehaviour.editMcp.scopeLocal")
                            : language.t("settings.agentBehaviour.editMcp.scopeGlobal")}
                        </span>
                        <span
                          style={{
                            "font-size": "10px",
                            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                          }}
                        >
                          {statusLabel(name) || (mcp.url ? "remote" : "stdio")}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                        <div onClick={(e: MouseEvent) => e.stopPropagation()}>
                          <Switch
                            checked={isConnected(name)}
                            disabled={busy() || session.mcpLoading() === name}
                            onChange={() => {
                              if (busy()) return
                              if (isConnected(name)) {
                                session.disconnectMcp(name)
                              } else {
                                session.connectMcp(name)
                              }
                            }}
                            hideLabel
                          >
                            {name}
                          </Switch>
                        </div>
                        <IconButton
                          size="small"
                          variant="ghost"
                          icon="close"
                          disabled={busy()}
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            if (busy()) return
                            confirmRemoveMcp(name)
                          }}
                        />
                        <IconButton
                          size="small"
                          variant="ghost"
                          icon="chevron-right"
                          disabled={busy()}
                          onClick={(e: MouseEvent) => {
                            e.stopPropagation()
                            if (busy()) return
                            setEditingMcp(name)
                          }}
                        />
                      </div>
                    </div>

                    {/* Error message */}
                    <Show when={error()}>
                      <div
                        style={{
                          "padding-left": "28px",
                          "padding-bottom": "4px",
                          "font-size": "11px",
                          color: "var(--vscode-errorForeground)",
                        }}
                      >
                        {error()}
                      </div>
                    </Show>

                    {/* Expandable detail */}
                    <Show when={open()}>
                      <div
                        style={{
                          "padding-left": "28px",
                          "padding-bottom": "8px",
                          "font-size": "12px",
                          color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                        }}
                      >
                        <Show when={mcp.command}>
                          <div style={{ "margin-bottom": "4px" }}>
                            <span style={{ "font-weight": "500" }}>
                              {language.t("settings.agentBehaviour.mcpDetail.command")}:{" "}
                            </span>
                            <span style={{ "font-family": "var(--vscode-editor-font-family, monospace)" }}>
                              {Array.isArray(mcp.command) ? mcp.command[0] : mcp.command}
                            </span>
                          </div>
                          <Show
                            when={
                              (Array.isArray(mcp.command) && mcp.command.length > 1) ||
                              (!Array.isArray(mcp.command) && mcp.args && mcp.args.length > 0)
                            }
                          >
                            <div style={{ "margin-bottom": "4px" }}>
                              <span style={{ "font-weight": "500" }}>
                                {language.t("settings.agentBehaviour.mcpDetail.args")}:{" "}
                              </span>
                              <span style={{ "font-family": "var(--vscode-editor-font-family, monospace)" }}>
                                {Array.isArray(mcp.command)
                                  ? (mcp.command as string[]).slice(1).join(" ")
                                  : (mcp.args ?? []).join(" ")}
                              </span>
                            </div>
                          </Show>
                        </Show>
                        <Show when={mcp.url}>
                          <div style={{ "margin-bottom": "4px" }}>
                            <span style={{ "font-weight": "500" }}>URL: </span>
                            <span style={{ "font-family": "var(--vscode-editor-font-family, monospace)" }}>
                              {mcp.url}
                            </span>
                          </div>
                        </Show>
                        <Show when={env().length > 0}>
                          <div style={{ "margin-bottom": "4px" }}>
                            <span style={{ "font-weight": "500" }}>
                              {language.t("settings.agentBehaviour.mcpDetail.env")}:
                            </span>
                          </div>
                          <For each={env()}>
                            {([key, val]) => (
                              <div
                                style={{
                                  "padding-left": "8px",
                                  "font-family": "var(--vscode-editor-font-family, monospace)",
                                }}
                              >
                                {key}={val}
                              </div>
                            )}
                          </For>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Card>
        </Show>
      </div>
    )
  }

  const renderSkillsSubtab = () => (
    <div>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "flex-end",
          "margin-bottom": "8px",
        }}
      >
        {/* <Button variant="secondary" size="small" onClick={browse}>
          {language.t("settings.agentBehaviour.mcpBrowseMarketplace")}
        </Button> */}
      </div>
      {/* Discovered skills */}
      <h4 style={{ "margin-top": "0", "margin-bottom": "8px" }}>
        {language.t("settings.agentBehaviour.discoveredSkills")}
      </h4>
      <Show
        when={session.skills().length > 0}
        fallback={
          <Card style={{ "margin-bottom": "16px" }}>
            <div data-slot="settings-row-label-subtitle">{language.t("settings.agentBehaviour.noSkillsFound")}</div>
          </Card>
        }
      >
        <Card style={{ "margin-bottom": "16px" }}>
          <For each={session.skills()}>
            {(skill, index) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "8px 0",
                  "border-bottom": index() < session.skills().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                }}
              >
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div data-slot="settings-row-label-title" style={{ "margin-bottom": "0" }}>
                    {skill.name}
                  </div>
                  <div
                    data-slot="settings-row-label-subtitle"
                    style={{
                      "margin-top": "4px",
                      "font-family": "var(--vscode-editor-font-family, monospace)",
                    }}
                  >
                    <div>{skill.description}</div>
                    {skill.location !== "builtin" && <div>{skill.location}</div>}
                  </div>
                </div>
                {skill.location !== "builtin" && (
                  <IconButton size="small" variant="ghost" icon="close" onClick={() => confirmRemoveSkill(skill)} />
                )}
              </div>
            )}
          </For>
        </Card>
      </Show>

      {/* Skill paths */}
      <h4 style={{ "margin-top": "0", "margin-bottom": "8px" }}>{language.t("settings.agentBehaviour.skillPaths")}</h4>
      <Card style={{ "margin-bottom": "16px" }}>
        <div
          style={{
            display: "flex",
            gap: "8px",
            "align-items": "center",
            padding: "8px 0",
            "border-bottom": skillPaths().length > 0 ? "1px solid var(--border-weak-base)" : "none",
          }}
        >
          <div style={{ flex: 1 }}>
            <TextField
              value={newSkillPath()}
              placeholder="e.g. ./skills"
              onChange={(val) => setNewSkillPath(val)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") addSkillPath()
              }}
            />
          </div>
          <Button variant="secondary" onClick={addSkillPath}>
            {language.t("common.add")}
          </Button>
        </div>
        <For each={skillPaths()}>
          {(path, index) => (
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                padding: "6px 0",
                "border-bottom": index() < skillPaths().length - 1 ? "1px solid var(--border-weak-base)" : "none",
              }}
            >
              <span
                style={{
                  "font-family": "var(--vscode-editor-font-family, monospace)",
                  "font-size": "12px",
                }}
              >
                {path}
              </span>
              <IconButton size="small" variant="ghost" icon="close" onClick={() => removeSkillPath(index())} />
            </div>
          )}
        </For>
      </Card>

      {/* Skill URLs */}
      {/* <h4 style={{ "margin-top": "0", "margin-bottom": "8px" }}>{language.t("settings.agentBehaviour.skillUrls")}</h4>
      <Card>
        <div
          style={{
            display: "flex",
            gap: "8px",
            "align-items": "center",
            padding: "8px 0",
            "border-bottom": skillUrls().length > 0 ? "1px solid var(--border-weak-base)" : "none",
          }}
        >
          <div style={{ flex: 1 }}>
            <TextField
              value={newSkillUrl()}
              placeholder="e.g. https://example.com/skills"
              onChange={(val) => setNewSkillUrl(val)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") addSkillUrl()
              }}
            />
          </div>
          <Button variant="secondary" onClick={addSkillUrl}>
            {language.t("common.add")}
          </Button>
        </div>
        <For each={skillUrls()}>
          {(url, index) => (
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                padding: "6px 0",
                "border-bottom": index() < skillUrls().length - 1 ? "1px solid var(--border-weak-base)" : "none",
              }}
            >
              <span
                style={{
                  "font-family": "var(--vscode-editor-font-family, monospace)",
                  "font-size": "12px",
                }}
              >
                {url}
              </span>
              <IconButton size="small" variant="ghost" icon="close" onClick={() => removeSkillUrl(index())} />
            </div>
          )}
        </For>
      </Card> */}
    </div>
  )
  // plugin tab
  const renderPluginsSubtab = () => (
    <div>
      <h4 style={{ "margin-top": "0", "margin-bottom": "8px" }}>已加载插件</h4>
      <Show
        when={plugins().length > 0}
        fallback={
          <Card style={{ "margin-bottom": "16px" }}>
            <div data-slot="settings-row-label-subtitle">当前运行时没有成功加载的外部插件。</div>
          </Card>
        }
      >
        <Card style={{ "margin-bottom": "16px" }}>
          <For each={plugins()}>
            {(plugin, index) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "8px 0",
                  "border-bottom": index() < plugins().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                  gap: "8px",
                }}
              >
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div data-slot="settings-row-label-title" style={{ "margin-bottom": "0" }}>
                    {plugin.name}
                  </div>
                  <div
                    data-slot="settings-row-label-subtitle"
                    style={{
                      "margin-top": "4px",
                      "font-family": "var(--vscode-editor-font-family, monospace)",
                      "overflow-wrap": "anywhere",
                    }}
                  >
                    <div>{plugin.description}</div>
                    <div>{plugin.path}</div>
                    <Show when={plugin.source}>
                      {(source) => (
                        <div>
                          {plugin.scope ? `${plugin.scope} · ` : ""}
                          {source()}
                        </div>
                      )}
                    </Show>
                    <Show when={plugin.options}>{(options) => <div>options: {JSON.stringify(options())}</div>}</Show>
                  </div>
                </div>
                <IconButton size="small" variant="ghost" icon="close" onClick={() => confirmRemovePlugin(plugin)} />
              </div>
            )}
          </For>
        </Card>
      </Show>
      <Show when={failedPlugins().length > 0}>
        <h4 style={{ "margin-top": "0", "margin-bottom": "8px" }}>加载失败插件</h4>
        <Card style={{ "margin-bottom": "16px" }}>
          <For each={failedPlugins()}>
            {(plugin, index) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "8px 0",
                  "border-bottom": index() < failedPlugins().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                  gap: "8px",
                }}
              >
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div data-slot="settings-row-label-title" style={{ "margin-bottom": "0" }}>
                    {plugin.name}
                  </div>
                  <div
                    data-slot="settings-row-label-subtitle"
                    style={{
                      "margin-top": "4px",
                      "font-family": "var(--vscode-editor-font-family, monospace)",
                      "overflow-wrap": "anywhere",
                    }}
                  >
                    <div>{plugin.description}</div>
                    <div>{plugin.path}</div>
                    <Show when={plugin.error}>{(error) => <div>error: {error()}</div>}</Show>
                    <Show when={plugin.source}>
                      {(source) => (
                        <div>
                          {plugin.scope ? `${plugin.scope} · ` : ""}
                          {source()}
                        </div>
                      )}
                    </Show>
                    <Show when={plugin.options}>{(options) => <div>options: {JSON.stringify(options())}</div>}</Show>
                  </div>
                </div>
                <IconButton size="small" variant="ghost" icon="close" onClick={() => confirmRemovePlugin(plugin)} />
              </div>
            )}
          </For>
        </Card>
      </Show>
    </div>
  )

  const renderRulesSubtab = () => (
    <div>
      {/* Description */}
      <div
        style={{
          "font-size": "12px",
          color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
          "margin-bottom": "12px",
          "line-height": "1.5",
        }}
      >
        {language.t("settings.agentBehaviour.rules.description")}
      </div>

      <Card>
        <div
          style={{
            "padding-bottom": "8px",
            "border-bottom": "1px solid var(--border-weak-base)",
          }}
        >
          <div style={{ "font-weight": "500" }}>{language.t("settings.agentBehaviour.instructionFiles")}</div>
          <div
            style={{
              "font-size": "12px",
              color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
              "margin-top": "2px",
            }}
          >
            {language.t("settings.agentBehaviour.instructionFiles.description")}
          </div>
        </div>

        {/* Add new instruction path */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            "align-items": "center",
            padding: "8px 0",
            "border-bottom": instructions().length > 0 ? "1px solid var(--border-weak-base)" : "none",
          }}
        >
          <div style={{ flex: 1 }}>
            <TextField
              value={newInstruction()}
              placeholder="e.g. ./INSTRUCTIONS.md"
              onChange={(val) => setNewInstruction(val)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") addInstruction()
              }}
            />
          </div>
          <Button variant="secondary" onClick={addInstruction}>
            {language.t("common.add")}
          </Button>
        </div>

        {/* Instructions list */}
        <For each={instructions()}>
          {(path, index) => (
            <div
              style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
                padding: "6px 0",
                "border-bottom": index() < instructions().length - 1 ? "1px solid var(--border-weak-base)" : "none",
              }}
            >
              <span
                style={{
                  "font-family": "var(--vscode-editor-font-family, monospace)",
                  "font-size": "12px",
                }}
              >
                {path}
              </span>
              <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                <IconButton
                  size="small"
                  variant="ghost"
                  icon="pencil-line"
                  onClick={() => vscode.postMessage({ type: "openFile", filePath: path })}
                />
                <IconButton size="small" variant="ghost" icon="close" onClick={() => removeInstruction(index())} />
              </div>
            </div>
          )}
        </For>
      </Card>

      {/* Claude Code compatibility */}
      <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>
        {language.t("settings.agentBehaviour.claudeCompat.heading")}
      </h4>
      <Card>
        <SettingsRow
          title={language.t("settings.agentBehaviour.claudeCompat.title")}
          description={language.t("settings.agentBehaviour.claudeCompat.description")}
          last
        >
          <Switch
            checked={claudeCompat()}
            onChange={(checked: boolean) => {
              setClaudeCompat(checked)
              vscode.postMessage({ type: "updateSetting", key: "claudeCodeCompat", value: checked })
            }}
            hideLabel
          >
            {language.t("settings.agentBehaviour.claudeCompat.title")}
          </Switch>
        </SettingsRow>
      </Card>
    </div>
  )

  const renderSubtabContent = () => {
    switch (activeSubtab()) {
      case "agents":
        return renderAgentsSubtab()
      case "mcpServers":
        return renderMcpSubtab()
      case "rules":
        return renderRulesSubtab()
      case "workflows":
        return <WorkflowsTab />
      case "skills":
        return renderSkillsSubtab()
      case "plugins":
        return renderPluginsSubtab()
      default:
        return null
    }
  }

  return (
    <div>
      {/* Horizontal subtab bar */}
      <div
        style={{
          display: "flex",
          gap: "0",
          "border-bottom": "1px solid var(--vscode-panel-border)",
          "margin-bottom": "16px",
        }}
      >
        <For each={subtabs}>
          {(subtab) => (
            <button
              onClick={() => {
                setActiveSubtab(subtab.id)
                // Reset views when switching subtabs
                if (subtab.id === "agents") {
                  setAgentView("list")
                  setEditingAgent("")
                }
                setEditingMcp("")
              }}
              style={{
                padding: "8px 16px",
                border: "none",
                background: "transparent",
                color:
                  activeSubtab() === subtab.id ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)",
                "font-size": "13px",
                "font-family": "var(--vscode-font-family)",
                cursor: "pointer",
                "border-bottom":
                  activeSubtab() === subtab.id ? "2px solid var(--vscode-foreground)" : "2px solid transparent",
                "margin-bottom": "-1px",
              }}
              onMouseEnter={(e) => {
                if (activeSubtab() !== subtab.id) {
                  e.currentTarget.style.color = "var(--vscode-foreground)"
                }
              }}
              onMouseLeave={(e) => {
                if (activeSubtab() !== subtab.id) {
                  e.currentTarget.style.color = "var(--vscode-descriptionForeground)"
                }
              }}
            >
              {language.t(subtab.labelKey)}
            </button>
          )}
        </For>
      </div>

      {/* Subtab content */}
      {renderSubtabContent()}
    </div>
  )
}

export default AgentBehaviourTab
