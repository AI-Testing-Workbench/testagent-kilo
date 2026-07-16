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

const SHELL_OPTIONS: SelectOption[] = [
  { value: "", label: "Default (System)" },
  { value: "powershell", label: "powershell" },
  { value: "cmd", label: "cmd.exe" },
  { value: "bash", label: "Git Bash" },
]

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

  onMount(() => {
    vscode.postMessage({ type: "checkGitInstalled" })
    // Load runtime from VS Code config
    vscode.postMessage({ type: "getRuntime" })
    // Load current npm registry
    vscode.postMessage({ type: "getNpmRegistry" })
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
  })
  onCleanup(unsubMsg)

  const currentShellOption = (): SelectOption | undefined => {
    const shell = config().shell ?? ""
    if (!shell) return SHELL_OPTIONS[0]
    const match = SHELL_OPTIONS.find((opt) => opt.value === shell)
    if (match) return match
    const base = shell
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.[^.]+$/, "")
      .toLowerCase()
    return SHELL_OPTIONS.find((opt) => base && opt.value === base)
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

  const getShellOptions = () => {
    const hasGit = gitInstalled()
    if (hasGit === false) {
      return SHELL_OPTIONS.filter((opt) => opt.value !== "bash")
    }
    return SHELL_OPTIONS
  }

  const currentNpmOption = (): SelectOption | undefined => {
    return npmRegistry() === INTERNAL_NPM_REGISTRY
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
      </Card>
    </div>
  )
}

export default NormalSetting
