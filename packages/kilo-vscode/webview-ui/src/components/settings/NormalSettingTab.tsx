import { Component, createSignal, onMount, onCleanup, createMemo, Show, For } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { Select } from "@kilocode/kilo-ui/select"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useConfig } from "../../context/config"
import { useVSCode } from "../../context/vscode"
import SettingsRow from "./SettingsRow"
import type { ExtensionMessage, AvailableTerminalInfo } from "../../types/messages"

interface SelectOption {
  value: string
  label: string
}

const LOG_LEVEL_OPTIONS: SelectOption[] = [
  { value: "DEBUG", label: "DEBUG" },
  { value: "INFO", label: "INFO" },
  { value: "WARN", label: "WARN" },
  { value: "ERROR", label: "ERROR" },
]

const RUNTIME_OPTIONS: SelectOption[] = [
  { value: "nodejs", label: "Node.js (默认)" },
  { value: "bun", label: "Bun" },
]

const INTERNAL_NPM_REGISTRY = `${decodeURIComponent(atob("aHR0cCUzQSUyRiUyRmNlbnRyYWwuamFmLmNtYmNoaW5hLmNu"))}/artifactory/api/npm/group-npm`

const NormalSetting: Component = () => {
  const { config, updateConfig } = useConfig()
  const vscode = useVSCode()
  const [gitInstalled, setGitInstalled] = createSignal<boolean | null>(null)
  const [runtime, setRuntime] = createSignal<"bun" | "nodejs">("nodejs")
  const [npmRegistry, setNpmRegistry] = createSignal("")
  const [npmRegistryLoading, setNpmRegistryLoading] = createSignal(true)
  const [availableTerminals, setAvailableTerminals] = createSignal<AvailableTerminalInfo[]>([])

  onMount(() => {
    vscode.postMessage({ type: "checkGitInstalled" })
    // Load runtime from VS Code config
    vscode.postMessage({ type: "getRuntime" })
    // Load current npm registry
    vscode.postMessage({ type: "getNpmRegistry" })
    // Load available terminals
    vscode.postMessage({ type: "getAvailableTerminals" })
  })

  const unsubMsg = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type === "gitInstalledResult") {
      setGitInstalled(msg.installed)
    }
    if (msg.type === "shellPathResolved") {
      if (msg.path) {
        const normalized = msg.path.replace(/\\/g, "/")
        // Avoid marking dirty if config already has this value (e.g. Select re-fired on config load)
        if (normalized === (config().shell ?? "")) return
        updateConfig({ shell: normalized })
      } else {
        showToast({
          variant: "error",
          title: "未找到 Shell 路径",
          description: `无法解析 ${msg.name} 的安装路径，请手动在配置文件中设置`,
        })
      }
    }
    if (msg.type === "runtimeResult") {
      setRuntime(msg.runtime)
    }
    if (msg.type === "npmRegistryResult") {
      setNpmRegistry(msg.registry)
      setNpmRegistryLoading(false)
    }
    if (msg.type === "availableTerminalsResult") {
      setAvailableTerminals(msg.terminals)
    }
  })
  onCleanup(unsubMsg)

  const currentShell = createMemo(() => config().shell ?? "")

  const handleShellInput = (e: Event) => {
    const target = e.target as HTMLInputElement
    const value = target.value.trim()
    updateConfig({ shell: value || undefined })
  }

  const handleTerminalClick = (term: AvailableTerminalInfo) => {
    updateConfig({ shell: term.path })
  }


  const currentRuntime = (): SelectOption | undefined => {
    return RUNTIME_OPTIONS.find((opt) => opt.value === runtime())
  }

  const handleRuntimeChange = (option: SelectOption | undefined) => {
    const value = option?.value as "bun" | "nodejs" | undefined
    if (!value || value === runtime()) return

    vscode.postMessage({ type: "changeRuntime", runtime: value })
    showToast({
      variant: "success",
      title: "运行时切换中",
      description: `正在切换到 ${value === "bun" ? "Bun" : "Node.js"} 运行时并重启 CLI...`,
    })
  }

  const currentNpmOption = (): SelectOption | undefined => {
    return npmRegistry().includes('artifactory/api/npm/group-npm')
      ? { value: INTERNAL_NPM_REGISTRY, label: "内网源" }
      : undefined
  }

  const handleNpmChange = (option: SelectOption | undefined) => {
    const value = option?.value ?? ""
    const current = npmRegistry()

    if (value === current) return

    vscode.postMessage({ type: "setNpmRegistry", registry: value })
    showToast({
      variant: "success",
      title: "npm 源已更新",
      description: "已切换到内网源",
    })
  }

  return (
    <div>
      {/* npm 源设置 */}
      <Card style={{ "margin-bottom": "12px" }}>
        <SettingsRow title="npm源" description="选择npm源">
          <Select
            options={[{ value: INTERNAL_NPM_REGISTRY, label: "内网源" }]}
            current={currentNpmOption()}
            value={(opt) => opt.value}
            label={(opt) => opt.label}
            onSelect={handleNpmChange}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            disabled={npmRegistryLoading()}
          />
        </SettingsRow>
        <SettingsRow
          title="后端服务运行时"
          description={`选择后端运行时 (当前: ${runtime() === "bun" ? "Bun" : "Node.js"})`}
        >
          <Select
            options={RUNTIME_OPTIONS}
            current={currentRuntime()}
            value={(opt) => opt.value}
            label={(opt) => opt.label}
            onSelect={handleRuntimeChange}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
        <SettingsRow title="终端 Shell" description="输入 agent 使用的默认终端路径，或点击下方列表中的项快速填入">
          <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "min-width": "360px", "width": "100%" }}>
            <input
              type="text"
              value={currentShell()}
              onInput={handleShellInput}
              placeholder="例如: /bin/bash 或 C:/Windows/System32/cmd.exe"
              style={{
                width: "100%",
                padding: "6px 10px",
                border: "1px solid var(--vscode-input-border, #ccc)",
                "border-radius": "4px",
                background: "var(--vscode-input-background, #fff)",
                color: "var(--vscode-input-foreground, #000)",
                "font-size": "13px",
                "box-sizing": "border-box",
              }}
            />

          </div>
        </SettingsRow>
        <Show when={availableTerminals().length > 0}>
          <div style={{ "margin": "10px 10px" }}>
            <div style={{ "font-size": "12px", color: "var(--vscode-descriptionForeground, #888)", "margin-bottom": "4px" }}>
              系统可用终端（点击行填入路径）:
            </div>
            <div style={{
              border: "1px solid var(--vscode-editorWidget-border, #ccc)",
              "border-radius": "4px",
              "overflow": "hidden",
            }}>
              <For each={availableTerminals()}>
                {(term, index) => (
                  <div
                    onClick={() => handleTerminalClick(term)}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      padding: "6px 10px",
                      "font-size": "12px",
                      cursor: "pointer",
                      background: index() % 2 === 0
                        ? "var(--vscode-list-hoverBackground, transparent)"
                        : "transparent",
                      "border-bottom": index() < availableTerminals().length - 1
                        ? "1px solid var(--vscode-editorWidget-border, #eee)"
                        : "none",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "var(--vscode-list-hoverBackground, #e8e8e8)"
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = index() % 2 === 0
                        ? "var(--vscode-list-hoverBackground, transparent)"
                        : "transparent"
                    }}
                  >
                    <span style={{ "font-weight": "600", "min-width": "80px", "margin-right": "8px" }}>{term.name}</span>
                    <span style={{ color: "var(--vscode-textLink-foreground, #06c)", "word-break": "break-all" }}>{term.path}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Card>
    </div>
  )
}

export default NormalSetting
