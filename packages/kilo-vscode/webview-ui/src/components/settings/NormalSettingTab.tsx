import { Component, createSignal, onMount, onCleanup } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { Select } from "@kilocode/kilo-ui/select"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useConfig } from "../../context/config"
import { useVSCode } from "../../context/vscode"
import SettingsRow from "./SettingsRow"
import type { ExtensionMessage } from "../../types/messages"

interface SelectOption {
  value: string
  label: string
}

const shellOptions: SelectOption[] = [
  { value: "", label: "Default (System)" },
  { value: "powershell", label: "powershell" },
  { value: "cmd", label: "cmd.exe" },
  { value: "bash", label: "Git Bash" },
]

const logLevelOptions: SelectOption[] = [
  { value: "DEBUG", label: "DEBUG" },
  { value: "INFO", label: "INFO" },
  { value: "WARN", label: "WARN" },
  { value: "ERROR", label: "ERROR" },
]

const runtimeOptions: SelectOption[] = [
  { value: "nodejs", label: "Node.js (默认)" },
  { value: "bun", label: "Bun" },
]

const NormalSetting: Component = () => {
  const { config, updateConfig } = useConfig()
  const vscode = useVSCode()
  const [gitInstalled, setGitInstalled] = createSignal<boolean | null>(null)
  const [runtime, setRuntime] = createSignal<"bun" | "nodejs">("nodejs")

  onMount(() => {
    vscode.postMessage({ type: "checkGitInstalled" })
    // Load runtime from VS Code config
    vscode.postMessage({ type: "getRuntime" })
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
  })
  onCleanup(unsubMsg)

  const currentShellOption = (): SelectOption | undefined => {
    const shell = config().shell ?? ""
    if (!shell) return shellOptions[0]
    const match = shellOptions.find((opt) => opt.value === shell)
    if (match) return match
    const base = shell
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.[^.]+$/, "")
      .toLowerCase()
    return shellOptions.find((opt) => base && opt.value === base)
  }

  const handleShellChange = (option: SelectOption | undefined) => {
    const value = option?.value ?? ""
    const current = config().shell ?? ""

    // Guard: selecting empty value but shell is already unset → no-op
    if (!value && !current) return

    // Guard: short name → skip if config already has this as the basename
    if (value && !value.includes("/")) {
      const configBase = current.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "").toLowerCase()
      if (configBase === value.toLowerCase()) return
    }

    if (value === "bash") {
      if (gitInstalled() === false) {
        showToast({
          variant: "error",
          title: "Git 未安装",
          description: "请先安装 Git 才能选择 Git Bash",
        })
        return
      }
      if (gitInstalled() === null) {
        showToast({
          variant: "error",
          title: "正在检查 Git 安装状态...",
        })
        return
      }
    }

    if (!value) {
      updateConfig({ shell: undefined })
      return
    }

    if (value.includes("/")) {
      if (value === current) return
      updateConfig({ shell: value })
      return
    }

    vscode.postMessage({ type: "resolveShellPath", name: value })
  }

  const handleLogLevelChange = (option: SelectOption | undefined) => {
    const value = option?.value as "DEBUG" | "INFO" | "WARN" | "ERROR" | undefined
    if (!value) return
    vscode.postMessage({ type: "restartServer", logLevel: value })
    showToast({
      variant: "success",
      title: "日志级别已更新",
      description: "正在重启 CLI 以使新日志级别生效...",
    })
  }

  const currentLogLevel = (): SelectOption | undefined => {
    return logLevelOptions.find((opt) => opt.value === "INFO")
  }

  const currentRuntime = (): SelectOption | undefined => {
    return runtimeOptions.find((opt) => opt.value === runtime())
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

  const getShellOptions = () => {
    const hasGit = gitInstalled()
    if (hasGit === false) {
      return shellOptions.filter((opt) => opt.value !== "bash")
    }
    return shellOptions
  }

  return (
    <div>
      {/* Shell 设置 */}
      <Card style={{ "margin-bottom": "12px" }}>
        <SettingsRow title="终端 Shell" description="选择 agent 使用的默认终端">
          <Select
            options={getShellOptions()}
            current={currentShellOption()}
            value={(opt) => opt.value}
            label={(opt) => opt.label}
            onSelect={handleShellChange}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
        <SettingsRow
          title="后端服务运行时"
          description={`选择后端运行时 (当前: ${runtime() === "bun" ? "Bun" : "Node.js"})`}
        >
          <Select
            options={runtimeOptions}
            current={currentRuntime()}
            value={(opt) => opt.value}
            label={(opt) => opt.label}
            onSelect={handleRuntimeChange}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
      </Card>
    </div>
  )
}

export default NormalSetting
