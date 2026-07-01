import { Component, Show, For, createEffect, createMemo, createSignal } from "solid-js"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Select } from "@kilocode/kilo-ui/select"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"

import { useConfig } from "../../context/config"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import type {
  AgentConfig,
  AgentInfo,
  PermissionConfig,
  PermissionLevel,
  PermissionRule,
  PermissionRuleItem,
} from "../../types/messages"
import SettingsRow from "./SettingsRow"
import { buildExport } from "./mode-io"

interface Props {
  name: string
  onBack: () => void
  onRemove: (agent: AgentInfo) => void
}

type Mode = "primary" | "subagent" | "all"
const modes: Mode[] = ["primary", "subagent", "all"]
const modeDescriptions: Record<Mode, string> = {
  primary: "此代理显示在 Agent 切换栏中，用户可直接选择使用。适用于通用任务。",
  subagent: "此代理不会显示在切换栏中，只能由其他 Agent 通过 @ 语法调用。适用于后台工具类代理。",
  all: "此代理既显示在切换栏中供用户选择，也可以被其他 Agent 调用。",
}

const ModeEditView: Component<Props> = (props) => {
  const language = useLanguage()
  const { config, updateConfig } = useConfig()
  const session = useSession()

  // agent() may be undefined for modes that only exist in the config draft (just
  // created, not yet saved). This is fine — native defaults to false (correct for
  // custom modes) and all fields read from cfg() which comes from config context.
  const agent = () => session.allAgents().find((a) => a.name === props.name)
  const native = () => agent()?.native ?? false
  const [expanded, setExpanded] = createSignal(true)
  const [focus, setFocus] = createSignal<"temp" | "top">()
  const [temp, setTemp] = createSignal("")
  const [top, setTop] = createSignal("")

  const cfg = createMemo<AgentConfig>(() => config().agent?.[props.name] ?? {})

  createEffect(() => {
    if (focus() === "temp") return
    setTemp(cfg().temperature?.toString() ?? "")
  })

  createEffect(() => {
    if (focus() === "top") return
    setTop(cfg().top_p?.toString() ?? "")
  })

  const update = (partial: Partial<AgentConfig>) => {
    const existing = config().agent ?? {}
    const current = existing[props.name] ?? {}
    updateConfig({
      agent: {
        ...existing,
        [props.name]: { ...current, ...partial },
      },
    })
  }

  const exportMode = () => {
    const data = buildExport(props.name, cfg())
    const json = JSON.stringify(data, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${props.name}.agent.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function cfgPermToRules(perm: PermissionConfig | undefined): PermissionRuleItem[] {
    if (!perm) return []
    const out: PermissionRuleItem[] = []
    for (const [key, val] of Object.entries(perm)) {
      if (typeof val === "string") {
        out.push({ permission: key, pattern: "*", action: val })
      } else if (val && typeof val === "object") {
        for (const [pattern, action] of Object.entries(val)) {
          if (action !== null) {
            out.push({ permission: key, pattern, action })
          }
        }
      }
    }
    return out
  }

  // Merge config permissions (editable) with computed permissions (read-only fallback).
  // Config values override computed ones so the table reflects the actual local state.
  const displayRules = createMemo(() => {
    const base = agent()?.permission ?? []
    const cfgRules = cfgPermToRules(cfg().permission)
    if (cfgRules.length === 0) return base

    const map = new Map<string, PermissionRuleItem>()
    for (const r of base) map.set(`${r.permission}\x00${r.pattern}`, r)
    for (const r of cfgRules) map.set(`${r.permission}\x00${r.pattern}`, r)
    return [...map.values()]
  })

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
            {language.t("settings.agentBehaviour.editMode")} — {props.name}
          </span>
        </div>
        <Show when={!native()}>
          <div style={{ display: "flex", gap: "4px" }}>
            <IconButton
              size="small"
              variant="ghost"
              icon="download"
              title={language.t("settings.agentBehaviour.exportMode")}
              onClick={exportMode}
            />
            <IconButton
              size="small"
              variant="ghost"
              icon="close"
              onClick={() => {
                const a = agent()
                if (a) props.onRemove(a)
              }}
            />
          </div>
        </Show>
      </div>

      <Show when={native()}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div
            style={{
              "font-size": "12px",
              color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
              padding: "4px 0",
            }}
          >
            {language.t("settings.agentBehaviour.editMode.native")}
          </div>
        </Card>
      </Show>

      {/* Mode (custom modes only) */}
      <Show when={!native()}>
        <Card data-variant="wide-input" style={{ "margin-bottom": "12px" }}>
          <SettingsRow title="代理模式" description="设置该代理模式" last>
            <Select<Mode>
              options={[...modes]}
              current={(modes as readonly string[]).includes(cfg().mode ?? "") ? (cfg().mode as Mode) : "primary"}
              value={(val) => val}
              label={(val) => val}
              onSelect={(val) => {
                if (!val) return
                update({ mode: val })
              }}
              variant="secondary"
              size="small"
            />
          </SettingsRow>
          <div
              style={{
                "text-align": "end",
                "font-size": "12px",
                color: "var(--vscode-descriptionForeground)",
                "margin-top": "6px",
                "line-height": "1.4",
                "align-self":'end'
              }}
            >
              {
                modeDescriptions[
                  (modes as readonly string[]).includes(cfg().mode ?? "") ? (cfg().mode as Mode) : "primary"
                ]
              }
            </div>
        </Card>
      </Show>

      {/* Description (full-width, custom modes only) */}
      <Show when={!native()}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.editMode.description")}
          </div>
          <TextField
            value={cfg().description ?? ""}
            placeholder={language.t("settings.agentBehaviour.createMode.description.placeholder")}
            onChange={(val) => update({ description: val || undefined })}
          />
        </Card>
      </Show>

      {/* Prompt (full-width, auto-resizing) */}
      <Card style={{ "margin-bottom": "12px" }}>
        <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
          {native()
            ? language.t("settings.agentBehaviour.editMode.promptOverride")
            : language.t("settings.agentBehaviour.editMode.prompt")}
        </div>
        <TextField
          value={cfg().prompt ?? ""}
          placeholder={language.t("settings.agentBehaviour.createMode.prompt.placeholder")}
          multiline
          onChange={(val) => update({ prompt: val || undefined })}
        />
      </Card>

      {/* Calculated permissions (editable, collapsible) */}
      <Show when={displayRules().length > 0}>
        <PermissionRuleset
          agent={props.name}
          rules={displayRules()}
          expanded={expanded()}
          onToggle={() => setExpanded((v) => !v)}
          onUpdate={(perm, pattern, action) => {
            const p = { ...(cfg().permission ?? {}) } as Record<string, PermissionRule>
            if (pattern === "*") {
              p[perm] = action
            } else {
              const merged = displayRules()
              const wc = merged.find((r) => r.permission === perm && r.pattern === "*")?.action ?? "allow"
              const base: Record<string, PermissionLevel> = { "*": wc as PermissionLevel }
              for (const r of merged) {
                if (r.permission === perm && r.pattern !== "*") base[r.pattern] = r.action as PermissionLevel
              }
              base[pattern] = action
              p[perm] = base
            }
            update({ permission: Object.keys(p).length ? p : undefined })
          }}
        />
      </Show>
      {/* Config overrides (wider inputs) */}
      <Card data-variant="wide-input" style={{ "margin-bottom": "12px" }}>
        <SettingsRow
          title={language.t("settings.agentBehaviour.modelOverride.title")}
          description={language.t("settings.agentBehaviour.modelOverride.description")}
        >
          <TextField
            value={cfg().model ?? ""}
            placeholder="e.g. anthropic/claude-sonnet-4-20250514"
            onChange={(val) => update({ model: val || undefined })}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.temperature.title")}
          description={language.t("settings.agentBehaviour.temperature.description")}
        >
          <TextField
            value={temp()}
            placeholder={language.t("common.default")}
            onFocus={() => setFocus("temp")}
            onBlur={() => setFocus(undefined)}
            onChange={(val) => {
              setTemp(val)
              const parsed = Number(val)
              update({ temperature: val.trim() === "" || Number.isNaN(parsed) ? undefined : parsed })
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.topP.title")}
          description={language.t("settings.agentBehaviour.topP.description")}
        >
          <TextField
            value={top()}
            placeholder={language.t("common.default")}
            onFocus={() => setFocus("top")}
            onBlur={() => setFocus(undefined)}
            onChange={(val) => {
              setTop(val)
              const parsed = Number(val)
              update({ top_p: val.trim() === "" || Number.isNaN(parsed) ? undefined : parsed })
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.maxSteps.title")}
          description={language.t("settings.agentBehaviour.maxSteps.description")}
        >
          <TextField
            value={cfg().steps?.toString() ?? ""}
            placeholder={language.t("common.default")}
            onChange={(val) => {
              const parsed = parseInt(val, 10)
              update({ steps: isNaN(parsed) ? undefined : parsed })
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.hidden.title")}
          description={language.t("settings.agentBehaviour.hidden.description")}
        >
          <Switch
            checked={cfg().hidden ?? false}
            onChange={(val) => {
              update({ hidden: val })
              // Clear default_agent if hiding the current default
              if (val && config().default_agent === props.name) {
                updateConfig({ default_agent: null })
              }
            }}
            hideLabel
          >
            {language.t("settings.agentBehaviour.hidden.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.disable.title")}
          description={language.t("settings.agentBehaviour.disable.description")}
          last
        >
          <Switch
            checked={cfg().disable ?? false}
            onChange={(val) => {
              update({ disable: val })
              // Clear default_agent if disabling the current default
              if (val && config().default_agent === props.name) {
                updateConfig({ default_agent: null })
              }
            }}
            hideLabel
          >
            {language.t("settings.agentBehaviour.disable.title")}
          </Switch>
        </SettingsRow>
      </Card>

      <div style={{ display: "flex", "justify-content": "flex-end" }}>
        <Button variant="ghost" onClick={props.onBack}>
          {language.t("settings.agentBehaviour.editMode.back")}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible permissions ruleset display
// ---------------------------------------------------------------------------

const ACTION_COLORS: Record<string, { bg: string; fg: string }> = {
  allow: { bg: "var(--vscode-terminal-ansiGreen, #3fb950)", fg: "var(--vscode-editor-background, #1e1e1e)" },
  ask: { bg: "var(--vscode-editorWarning-foreground, #cca700)", fg: "var(--vscode-editor-background, #1e1e1e)" },
  deny: { bg: "var(--vscode-errorForeground, #f85149)", fg: "var(--vscode-editor-background, #fff)" },
  unknown: { bg: "var(--vscode-descriptionForeground, #8b949e)", fg: "var(--vscode-editor-background, #1e1e1e)" },
}

interface RulesetProps {
  agent: string
  rules: PermissionRuleItem[]
  expanded: boolean
  onToggle: () => void
  onUpdate?: (permission: string, pattern: string, action: PermissionLevel) => void
}

const PermissionRuleset: Component<RulesetProps> = (props) => {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)

  // Compute effective action per unique tool by finding the last rule with pattern "*"
  // NOTE: This assumes the CLI uses "*" as the wildcard pattern for catch-all rules.
  // If the CLI convention changes (e.g. to "**" or another pattern), this will need updating.
  const summary = createMemo(() => {
    const tools = new Map<string, PermissionRuleItem["action"]>()
    for (const rule of props.rules) {
      if (rule.pattern === "*") {
        tools.set(rule.permission, rule.action)
      }
    }
    return [...tools.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })

  const BUILTIN_ORDER = [
    "question",
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "task",
    "webfetch",
    "todowrite",
    "skill",
    "sandbox",
  ]

  // Deduplicate by permission+pattern (last wins — matches backend findLast semantics).
  // Then expand the wildcard (*/*) into individual rows for each built-in tool that
  // doesn't already have an explicit pattern="*" entry, so users can override any tool.
  const sortedRules = createMemo(() => {
    const dedup = new Map<string, PermissionRuleItem>()
    for (const rule of props.rules) {
      dedup.set(`${rule.permission}\x00${rule.pattern}`, rule)
    }

    // Extract wildcard action and remove the wildcard row (re-added later)
    const wildcard = dedup.get("*\x00*")
    dedup.delete("*\x00*")

    // For each built-in tool without an explicit pattern="*" entry, add an inferred row
    const hasWildcard = new Set<string>()
    for (const rule of dedup.values()) {
      if (rule.pattern === "*") hasWildcard.add(rule.permission)
    }
    for (const tool of BUILTIN_ORDER) {
      if (!hasWildcard.has(tool) && wildcard) {
        dedup.set(`${tool}\x00*`, { permission: tool, pattern: "*", action: wildcard.action })
      }
    }

    // Re-add wildcard row at the end for non-built-in tools
    if (wildcard) dedup.set("*\x00*", wildcard)

    return [...dedup.values()].sort((a, b) => {
      const ai = BUILTIN_ORDER.indexOf(a.permission)
      const bi = BUILTIN_ORDER.indexOf(b.permission)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      if (a.pattern === "*" && b.pattern !== "*") return -1
      if (a.pattern !== "*" && b.pattern === "*") return 1
      return a.permission.localeCompare(b.permission)
    })
  })

  const copy = (e: MouseEvent) => {
    e.stopPropagation()
    const data = { agent: props.agent, rules: props.rules }
    navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card style={{ "margin-bottom": "12px" }}>
      <div
        style={{ display: "flex", "align-items": "center", cursor: "pointer", "user-select": "none" }}
        onClick={props.onToggle}
      >
        <IconButton
          size="small"
          variant="ghost"
          icon={props.expanded ? "chevron-down" : "chevron-right"}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            props.onToggle()
          }}
        />
        <span data-slot="settings-row-label-title" style={{ "margin-left": "4px" }}>
          {language.t("settings.agentBehaviour.permissions.title")}
        </span>
        <span
          style={{
            "margin-left": "8px",
            "font-size": "11px",
            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
          }}
        >
          {language.t("settings.agentBehaviour.permissions.count", { count: String(props.rules.length) })}
        </span>
        <div style={{ "margin-left": "auto" }}>
          <IconButton
            size="small"
            variant="ghost"
            icon={copied() ? "check" : "copy"}
            title={language.t("settings.agentBehaviour.permissions.copy")}
            onClick={copy}
          />
        </div>
      </div>

      <Show when={props.expanded}>
        {/* Summary: effective action per tool for wildcard pattern */}
        <Show when={summary().length > 0}>
          <div style={{ "margin-top": "8px", "margin-bottom": "8px" }}>
            <div
              style={{
                "font-size": "11px",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                "margin-bottom": "4px",
              }}
            >
              {language.t("settings.agentBehaviour.permissions.effective")}
            </div>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
              <For each={summary()}>
                {([tool, action]) => {
                  const colors = ACTION_COLORS[action] ?? ACTION_COLORS.unknown
                  return (
                    <span
                      style={{
                        "font-size": "11px",
                        padding: "2px 6px",
                        "border-radius": "3px",
                        background: colors.bg,
                        color: colors.fg,
                        "font-family": "var(--vscode-editor-font-family, monospace)",
                      }}
                    >
                      {tool}: {action}
                    </span>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Full ruleset table */}
        <div
          style={{
            "margin-top": "8px",
            "font-size": "11px",
            "font-family": "var(--vscode-editor-font-family, monospace)",
            "max-height": "300px",
            "overflow-y": "auto",
            border: "1px solid var(--border-weak-base, var(--vscode-panel-border))",
            "border-radius": "4px",
          }}
        >
          <table style={{ width: "100%", "border-collapse": "collapse" }}>
            <thead>
              <tr
                style={{
                  background: "var(--bg-subtle-base, var(--vscode-editorWidget-background))",
                  position: "sticky",
                  top: "0",
                }}
              >
                <th style={{ padding: "4px 8px", "text-align": "left", "font-weight": "600" }}>
                  {language.t("settings.agentBehaviour.permissions.col.tool")}
                </th>
                <th style={{ padding: "4px 8px", "text-align": "left", "font-weight": "600" }}>
                  {language.t("settings.agentBehaviour.permissions.col.pattern")}
                </th>
                <th style={{ padding: "4px 8px", "text-align": "left", "font-weight": "600" }}>
                  {language.t("settings.agentBehaviour.permissions.col.action")}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={sortedRules()}>
                {(rule, idx) => {
                  const colors = ACTION_COLORS[rule.action] ?? ACTION_COLORS.unknown
                  return (
                    <tr
                      style={{
                        "border-top":
                          idx() > 0 ? "1px solid var(--border-weak-base, var(--vscode-panel-border))" : "none",
                      }}
                    >
                      <td style={{ padding: "3px 8px" }}>{rule.permission}</td>
                      <td style={{ padding: "3px 8px", color: "var(--text-weak-base)" }}>{rule.pattern}</td>
                      <td style={{ padding: "3px 8px" }}>
                        <Show
                          when={props.onUpdate}
                          fallback={
                            <span
                              style={{
                                padding: "1px 4px",
                                "border-radius": "2px",
                                background: colors.bg,
                                color: colors.fg,
                              }}
                            >
                              {rule.action}
                            </span>
                          }
                        >
                          <ActionCellDropdown
                            action={rule.action as PermissionLevel}
                            onChange={(action) => props.onUpdate!(rule.permission, rule.pattern, action)}
                          />
                        </Show>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>

        <div
          style={{
            "margin-top": "6px",
            "font-size": "10px",
            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
          }}
        >
          {language.t("settings.agentBehaviour.permissions.hint")}
        </div>
      </Show>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Inline action dropdown for editable permission table
// ---------------------------------------------------------------------------

const ActionCellDropdown: Component<{
  action: PermissionLevel
  onChange: (action: PermissionLevel) => void
}> = (props) => {
  const language = useLanguage()
  const opts: { value: PermissionLevel; label: string }[] = [
    { value: "allow", label: language.t("settings.autoApprove.level.allow") },
    { value: "ask", label: language.t("settings.autoApprove.level.ask") },
    { value: "deny", label: language.t("settings.autoApprove.level.deny") },
  ]
  return (
    <Select
      options={opts}
      current={opts.find((o) => o.value === props.action)}
      value={(o) => o.value}
      label={(o) => o.label}
      onSelect={(o) => o && props.onChange(o.value)}
      variant="secondary"
      size="small"
      triggerVariant="settings"
    />
  )
}

export default ModeEditView
