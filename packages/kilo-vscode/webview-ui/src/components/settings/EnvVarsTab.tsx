import { Component, createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useVSCode } from "../../context/vscode"
import SettingsRow from "./SettingsRow"

interface EnvVar {
  key: string
  value: string
}

const EnvVarsTab: Component = () => {
  const vscode = useVSCode()
  const [systemVars, setSystemVars] = createSignal<EnvVar[]>([])
  const [customVars, setCustomVars] = createSignal<EnvVar[]>([])
  const [loadError, setLoadError] = createSignal("")
  const [newKey, setNewKey] = createSignal("")
  const [newValue, setNewValue] = createSignal("")
  const [keyError, setKeyError] = createSignal("")
  const [valueError, setValueError] = createSignal("")
  // 编辑状态：记录正在编辑的变量 key
  const [editingKey, setEditingKey] = createSignal<string | null>(null)
  const [editValue, setEditValue] = createSignal("")
  const [editValueError, setEditValueError] = createSignal("")

  onMount(() => {
    vscode.postMessage({ type: "requestEnvVars" })
  })

  const unsub = vscode.onMessage((msg) => {
    if (msg.type === "envVarsData") {
      const envVarsMsg = msg as {
        type: "envVarsData"
        envVars: { system: Record<string, EnvVar>; custom: Record<string, EnvVar> }
        error?: string
      }
      setSystemVars(Object.values(envVarsMsg.envVars.system))
      setCustomVars(Object.values(envVarsMsg.envVars.custom))
      setLoadError(envVarsMsg.error || "")
    }
  })
  onCleanup(unsub)

  const validateKey = (key: string) => {
    if (!key) return "Key 不能为空"
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      return "Key 必须以字母或下划线开头，并且只能包含字母、数字和下划线"
    }
    if (customVars().some((v) => v.key === key)) {
      return "Key 已存在"
    }
    return ""
  }

  const handleAdd = () => {
    const keyErr = validateKey(newKey())
    const valueErr = !newValue() ? "Value 不能为空" : ""
    
    setKeyError(keyErr)
    setValueError(valueErr)
    
    if (keyErr || valueErr) return
    
    vscode.postMessage({
      type: "createEnvVar",
      key: newKey(),
      value: newValue(),
    })
    // 清空输入
    setNewKey("")
    setNewValue("")
    setKeyError("")
    setValueError("")
  }

  const handleDelete = (key: string) => {
    vscode.postMessage({ type: "deleteEnvVar", key })
  }

  const startEdit = (v: EnvVar) => {
    setEditingKey(v.key)
    setEditValue(v.value)
    setEditValueError("")
  }

  const cancelEdit = () => {
    setEditingKey(null)
    setEditValue("")
    setEditValueError("")
  }

  const saveEdit = (key: string) => {
    if (!editValue()) {
      setEditValueError("Value 不能为空")
      return
    }
    vscode.postMessage({
      type: "updateEnvVar",
      key,
      value: editValue(),
    })
    setEditingKey(null)
    setEditValueError("")
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <Show when={loadError()}>
        <Card style={{ "background-color": "var(--danger-bg)", border: "1px solid var(--danger)" }}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <span style={{ color: "var(--danger)", "font-weight": "bold", "font-size": "16px" }}>⚠</span>
              <h4 style={{ margin: 0, color: "var(--danger)" }}>环境变量配置文件错误</h4>
            </div>
            <pre style={{ 
              margin: 0, 
              padding: "12px", 
              "background-color": "var(--bg-subtle)", 
              "border-radius": "4px",
              "white-space": "pre-wrap",
              "word-wrap": "break-word",
              "font-family": "monospace",
              "font-size": "13px",
              color: "var(--text)",
              "overflow-x": "auto"
            }}>
              {loadError()}
            </pre>
          </div>
        </Card>
      </Show>

      <Card>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          用于配置工具运行参数，存储敏感信息的密钥对，避免敏感信息硬编码泄露。
          <br />
          分为自动注入的系统环境变量和自定义环境变量，<strong>自定义环境变量仅本人可调用。</strong>
          <br />
          存在相同变量名时，<strong>自定义环境变量覆盖同名的系统环境变量。</strong>
        </p>
      </Card>

      <Card data-variant="wide-input" data-env-vars="add">
        <h4>添加环境变量</h4>
        <SettingsRow title="Key" description="变量名" last>
          <TextField
            value={newKey()}
            onChange={setNewKey}
            placeholder="字母/下划线开头，仅字母数字下划线"
            class="env-vars-key-input"
            validationState={keyError() ? "invalid" : undefined}
            error={keyError()}
            style={{ width: "100%" }}
          />
        </SettingsRow>
        <SettingsRow title="Value" description="变量值" last>
          <TextField 
            value={newValue()} 
            onChange={setNewValue}
            validationState={valueError() ? "invalid" : undefined}
            error={valueError()}
            style={{ width: "100%" }}
          />
        </SettingsRow>
        <Button onClick={handleAdd} style={{ "margin-top": "8px" }}>
          保存环境变量
        </Button>
      </Card>

      <div>
        <h4 style={{ margin: "0 0 4px" }}>已配置环境变量</h4>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          包括系统环境变量和自定义环境变量。
        </p>
      </div>

      <Card data-variant="wide-input" data-env-vars="system">
        <h4>系统环境变量（自动注入）</h4>
        <For each={systemVars()}>
          {(v) => (
            <SettingsRow title={v.key} last>
              <div
                title={v.value}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  border: "1px solid var(--border-weak-base)",
                  "border-radius": "4px",
                  color: "var(--text-weak-base)",
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                }}
              >
                {v.value}
              </div>
            </SettingsRow>
          )}
        </For>
        <Show when={systemVars().length === 0}>
          <p style={{ color: "var(--text-muted)" }}>暂无系统环境变量</p>
        </Show>
      </Card>

      <Card data-variant="wide-input" data-env-vars="configured">
        <h4>自定义环境变量</h4>
        <For each={customVars()}>
          {(v) => (
            <SettingsRow title={v.key}>
              <Show
                when={editingKey() === v.key}
                fallback={
                  <div style={{ display: "flex", gap: "8px", "align-items": "center", width: "100%", "min-width": 0 }}>
                    <div
                      title={v.value}
                      style={{
                        flex: 1,
                        "min-width": 0,
                        padding: "6px 8px",
                        border: "1px solid var(--border-weak-base)",
                        "border-radius": "4px",
                        color: "var(--text-weak-base)",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                    >
                      {v.value}
                    </div>
                    <Button 
                      variant="ghost" 
                      size="small" 
                      onClick={() => startEdit(v)}
                      style={{ "flex-shrink": 0 }}
                    >
                      编辑
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="small" 
                      onClick={() => handleDelete(v.key)}
                      style={{ "flex-shrink": 0 }}
                    >
                      删除
                    </Button>
                  </div>
                }
              >
                <div style={{ display: "flex", "flex-direction": "column", gap: "12px", width: "100%" }}>
                  <div>
                    <label style={{ display: "block", "margin-bottom": "4px", "font-size": "12px", "font-weight": 500 }}>
                      Value (变量值)
                    </label>
                    <TextField 
                      value={editValue()} 
                      onChange={(value) => {
                        setEditValue(value)
                        setEditValueError("")
                      }}
                      placeholder="变量值"
                      validationState={editValueError() ? "invalid" : undefined}
                      error={editValueError()}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <Button variant="primary" size="small" onClick={() => saveEdit(v.key)}>
                      保存
                    </Button>
                    <Button variant="ghost" size="small" onClick={cancelEdit}>
                      取消
                    </Button>
                  </div>
                </div>
              </Show>
            </SettingsRow>
          )}
        </For>
        <Show when={customVars().length === 0}>
          <p style={{ color: "var(--text-muted)" }}>暂无自定义环境变量</p>
        </Show>
      </Card>
    </div>
  )
}

export default EnvVarsTab
