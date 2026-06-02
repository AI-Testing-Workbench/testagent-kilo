import { Component, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useVSCode } from "../../context/vscode"
import SettingsRow from "./SettingsRow"
import type { ExtensionMessage, MemorySettingsConfig } from "../../types/messages"

const defaults: MemorySettingsConfig = {
  enable: false,
  debug: false,
  cmd: {
    memory: true,
    dream: true,
  },
  memory: {
    autoExtractMaxLength: 10000,
    autoExtractBufferSize: 10,
    personalMemoryEnable: true,
    personalMemoryPrompt: "",
    autoDreamEnable: true,
    autoExtractEnable: true,
  },
  recall: {
    recallEnable: true,
    llmRecall: false,
    providerID: "",
    modelID: "",
  },
}

const clone = (cfg: MemorySettingsConfig): MemorySettingsConfig => JSON.parse(JSON.stringify(cfg))

const same = (a: MemorySettingsConfig, b: MemorySettingsConfig) => JSON.stringify(a) === JSON.stringify(b)

const num = (value: string, fallback: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.floor(parsed))
}

const MemorySettings: Component = () => {
  const vscode = useVSCode()
  const [cfg, setCfg] = createSignal<MemorySettingsConfig>(clone(defaults))
  const [saved, setSaved] = createSignal<MemorySettingsConfig>(clone(defaults))
  const [file, setFile] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)

  const dirty = createMemo(() => !same(cfg(), saved()))

  onMount(() => {
    vscode.postMessage({ type: "requestMemorySettings" })
  })

  const unsub = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type === "memorySettingsLoaded") {
      setCfg(clone(msg.settings))
      setSaved(clone(msg.settings))
      setFile(msg.path)
      setLoading(false)
      if (msg.error) {
        showToast({ variant: "error", title: "记忆配置读取失败", description: msg.error })
      }
    }
    if (msg.type === "memorySettingsSaved") {
      setCfg(clone(msg.settings))
      setSaved(clone(msg.settings))
      setFile(msg.path)
      setSaving(false)
      showToast({
        variant: "success",
        title: "记忆配置已保存",
        description: msg.reloaded ? "记忆插件已重新加载" : "后端未连接，插件会在下次初始化时读取配置",
      })
    }
    if (msg.type === "memorySettingsFailed") {
      setSaving(false)
      showToast({ variant: "error", title: "记忆配置保存失败", description: msg.message })
    }
  })
  onCleanup(unsub)

  const update = (patch: Partial<MemorySettingsConfig>) => {
    setCfg((prev) => ({ ...prev, ...patch }))
  }

  const cmd = (patch: Partial<MemorySettingsConfig["cmd"]>) => {
    setCfg((prev) => ({ ...prev, cmd: { ...prev.cmd, ...patch } }))
  }

  const memory = (patch: Partial<MemorySettingsConfig["memory"]>) => {
    setCfg((prev) => ({ ...prev, memory: { ...prev.memory, ...patch } }))
  }

  const recall = (patch: Partial<MemorySettingsConfig["recall"]>) => {
    setCfg((prev) => ({ ...prev, recall: { ...prev.recall, ...patch } }))
  }

  const save = () => {
    setSaving(true)
    vscode.postMessage({ type: "updateMemorySettings", settings: cfg() })
  }

  const reset = () => {
    setCfg(clone(defaults))
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <Card>
        <SettingsRow title="记忆插件" description="启用或关闭 testagent-memory 内置插件。">
          <Switch checked={cfg().enable} onChange={(checked) => update({ enable: checked })} hideLabel>
            记忆插件
          </Switch>
        </SettingsRow>
        <SettingsRow title="调试日志" description="输出更多记忆插件日志，便于定位初始化、召回和整理流程。" last>
          <Switch checked={cfg().debug} onChange={(checked) => update({ debug: checked })} hideLabel>
            调试日志
          </Switch>
        </SettingsRow>
      </Card>

      <Card>
        <SettingsRow title="初始化 memory 命令" description="创建或保留 commands/memory.md。">
          <Switch checked={cfg().cmd.memory} onChange={(checked) => cmd({ memory: checked })} hideLabel>
            初始化 memory 命令
          </Switch>
        </SettingsRow>
        <SettingsRow title="初始化 dream 命令" description="创建或保留 commands/dream.md。" last>
          <Switch checked={cfg().cmd.dream} onChange={(checked) => cmd({ dream: checked })} hideLabel>
            初始化 dream 命令
          </Switch>
        </SettingsRow>
      </Card>

      <Card data-variant="wide-input">
        <SettingsRow title="自动提取" description="会话空闲后按缓存大小触发记忆提取。">
          <Switch checked={cfg().memory.autoExtractEnable} onChange={(checked) => memory({ autoExtractEnable: checked })} hideLabel>
            自动提取
          </Switch>
        </SettingsRow>
        <SettingsRow title="提取缓存大小" description="缓存消息数量达到该值后才允许自动提取。">
          <TextField
            type="number"
            value={cfg().memory.autoExtractBufferSize.toString()}
            onChange={(value) => memory({ autoExtractBufferSize: num(value, cfg().memory.autoExtractBufferSize) })}
          />
        </SettingsRow>
        <SettingsRow title="提取最大长度" description="单次记忆提取可处理的最大字符数。">
          <TextField
            type="number"
            value={cfg().memory.autoExtractMaxLength.toString()}
            onChange={(value) => memory({ autoExtractMaxLength: num(value, cfg().memory.autoExtractMaxLength) })}
          />
        </SettingsRow>
        <SettingsRow title="自动整理" description="达到整理轮次后运行 Auto Dream。">
          <Switch checked={cfg().memory.autoDreamEnable} onChange={(checked) => memory({ autoDreamEnable: checked })} hideLabel>
            自动整理
          </Switch>
        </SettingsRow>
        <SettingsRow title="个人全局记忆" description="启用个人全局记忆提取与合并。">
          <Switch
            checked={cfg().memory.personalMemoryEnable}
            onChange={(checked) => memory({ personalMemoryEnable: checked })}
            hideLabel
          >
            个人全局记忆
          </Switch>
        </SettingsRow>
        <SettingsRow title="个人记忆提示词" description="留空时使用插件内置提示词。" last>
          <TextField
            value={cfg().memory.personalMemoryPrompt}
            placeholder="默认提示词"
            multiline
            onChange={(value) => memory({ personalMemoryPrompt: value })}
          />
        </SettingsRow>
      </Card>

      <Card data-variant="wide-input">
        <SettingsRow title="记忆召回" description="在对话中召回历史记忆。">
          <Switch checked={cfg().recall.recallEnable} onChange={(checked) => recall({ recallEnable: checked })} hideLabel>
            记忆召回
          </Switch>
        </SettingsRow>
        <SettingsRow title="LLM 语义召回" description="向量召回后使用模型进行语义精排。">
          <Switch checked={cfg().recall.llmRecall} onChange={(checked) => recall({ llmRecall: checked })} hideLabel>
            LLM 语义召回
          </Switch>
        </SettingsRow>
        <SettingsRow title="Provider ID" description="语义召回使用的 LLM 服务提供商 ID。">
          <TextField value={cfg().recall.providerID} placeholder="默认使用当前模型" onChange={(value) => recall({ providerID: value })} />
        </SettingsRow>
        <SettingsRow title="Model ID" description="语义召回使用的 LLM 模型 ID。" last>
          <TextField value={cfg().recall.modelID} placeholder="默认使用当前模型" onChange={(value) => recall({ modelID: value })} />
        </SettingsRow>
      </Card>

      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          gap: "8px",
          "flex-wrap": "wrap",
        }}
      >
        <div style={{ color: "var(--text-weak-base, var(--vscode-descriptionForeground))", "font-size": "12px" }}>
          <Show when={file()} fallback={loading() ? "正在读取记忆配置..." : "尚未创建配置文件"}>
            {(path) => path()}
          </Show>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button variant="ghost" size="small" onClick={reset} disabled={saving()}>
            恢复默认
          </Button>
          <Button variant="primary" size="small" onClick={save} disabled={!dirty() || saving()}>
            {saving() ? "保存中..." : "保存"}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default MemorySettings
