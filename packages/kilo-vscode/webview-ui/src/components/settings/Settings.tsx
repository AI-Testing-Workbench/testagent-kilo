import { Component, createSignal, createEffect, on, Show } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tabs } from "@kilocode/kilo-ui/tabs"
import { Button } from "@kilocode/kilo-ui/button"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { useConfig } from "../../context/config"
import { useSession } from "../../context/session"
import ModelsTab from "./ModelsTab"
import ProvidersTab from "./ProvidersTab"
import AgentBehaviourTab from "./AgentBehaviourTab"
import AutoApproveTab from "./AutoApproveTab"
import BrowserTab from "./BrowserTab"
import CheckpointsTab from "./CheckpointsTab"
import DisplayTab from "./DisplayTab"
import AutocompleteTab from "./AutocompleteTab"
import NotificationsTab from "./NotificationsTab"
import ContextTab from "./ContextTab"
import NormalSettingTab from "./NormalSettingTab"
import MemorySettingTab from "./MemorySettings"
import GoalTab, { GoalIcon } from "./GoalTab" // testagent_change

export interface SettingsProps {
  tab?: string
  onTabChange?: (tab: string) => void
  onMigrateClick?: () => void // legacy-migration
}

const Settings: Component<SettingsProps> = (props) => {
  const language = useLanguage()
  const vscode = useVSCode()
  const { isDirty, saving, saveError, saveConfig, discardConfig } = useConfig()
  const session = useSession()
  const [active, setActive] = createSignal(props.tab ?? "models")
  const [errorExpanded, setErrorExpanded] = createSignal(false)
  // memory 配置的独立保存状态
  const [memoryDirty, setMemoryDirty] = createSignal(false)
  let memSave: (() => void) | null = null
  let memDiscard: (() => void) | null = null

  const busyCount = () => Object.values(session.allStatusMap()).filter((s) => s.type === "busy").length

  const handleSave = () => {
    const busy = busyCount()
    if (busy === 0) {
      saveConfig()
      return
    }
    const msg = busy === 1 ? language.t("settings.saveBar.warning.one") : language.t("settings.saveBar.warning.many")
    showToast({
      variant: "error",
      title: msg,
      persistent: true,
      actions: [
        // { label: language.t("settings.saveBar.saveAnyway"), onClick: "dismiss" },
        { label: language.t("settings.saveBar.cancel"), onClick: "dismiss" },
      ],
    })
  }

  // 统一保存：settings 和 memory 各自走自己的保存逻辑
  const handleSaveAll = () => {
    if (isDirty()) handleSave()
    if (memoryDirty() && memSave) memSave()
  }

  // 统一丢弃：两边各自丢弃未保存更改
  const handleDiscardAll = () => {
    if (isDirty()) discardConfig()
    if (memoryDirty() && memDiscard) memDiscard()
  }

  // Sync when the parent changes the tab prop (e.g. via navigate message)
  createEffect(
    on(
      () => props.tab,
      (tab) => {
        if (tab) setActive(tab)
      },
    ),
  )

  const onTabChange = (tab: string) => {
    setActive(tab)
    props.onTabChange?.(tab)
    vscode.postMessage({ type: "settingsTabChanged", tab })
  }

  // 打开个性化配置文件
  const open = (scope: "local" | "global") => {
    vscode.postMessage({ type: "openConfigFile", scope })
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100%", "min-height": 0 }}>

      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          "border-bottom": "1px solid var(--border-weak-base)",
          display: "flex",
          "align-items": "center",
          "flex-wrap": "wrap",
          gap: "8px",
        }}
      >
        <h2 style={{ "font-size": "16px", "font-weight": "600", margin: 0, flex: 1 }}>
          {language.t("sidebar.settings")}
        </h2>
        <Button variant="secondary" size="small" icon="edit" onClick={() => open("local")}>
          项目配置
        </Button>
        <Button variant="secondary" size="small" icon="edit" onClick={() => open("global")}>
          全局配置
        </Button>
      </div>

      {/* Settings tabs */}
      <Tabs
        orientation="vertical"
        variant="settings"
        value={active()}
        onChange={onTabChange}
        style={{ flex: 1, overflow: "hidden" }}
      >
        <Tabs.List>
          <Tabs.Trigger value="models">
            <Icon name="models" />
            <span class="label">{language.t("settings.models.title")}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="providers">
            <Icon name="providers" />
            <span class="label">{language.t("settings.providers.title")}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="agentBehaviour">
            <Icon name="brain" />
            <span class="label">{language.t("settings.agentBehaviour.title")}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="autoApprove">
            <Icon name="checklist" />
            <span class="label">{language.t("settings.autoApprove.title")}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="browser">
            <Icon name="window-cursor" />
            <span class="label">{language.t("settings.browser.title")}</span>
          </Tabs.Trigger>
          {/* <Tabs.Trigger value="autocomplete">
            <Icon name="code-lines" />
            <span class="label">{language.t("settings.autocomplete.title")}</span>
          </Tabs.Trigger> */}
          <Tabs.Trigger value="notifications">
            <Icon name="circle-check" />
            <span class="label">{language.t("settings.notifications.title")}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="context">
            <Icon name="server" />
            <span class="label">{language.t("settings.context.title")}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="memorySettings">
            <Icon name="brain" />
            <span class="label">记忆设置</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="normalSetting">
            <Icon name="settings-gear" />
            <span class="label">通用设置</span>
          </Tabs.Trigger>
          {/* testagent_change start - expose experimental settings */}
          <Tabs.Trigger value="experimental">
            <GoalIcon />
            <span class="label">{language.t("settings.experimental.title")}</span>
          </Tabs.Trigger>
          {/* testagent_change end */}
        </Tabs.List>

        <Tabs.Content value="models">
          <h3>{language.t("settings.models.title")}</h3>
          <ModelsTab />
        </Tabs.Content>
        <Tabs.Content value="providers">
          <h3>{language.t("settings.providers.title")}</h3>
          <ProvidersTab />
        </Tabs.Content>
        <Tabs.Content value="agentBehaviour">
          <h3>{language.t("settings.agentBehaviour.title")}</h3>
          <AgentBehaviourTab />
        </Tabs.Content>
        <Tabs.Content value="autoApprove">
          <h3>{language.t("settings.autoApprove.title")}</h3>
          <AutoApproveTab />
        </Tabs.Content>
        <Tabs.Content value="browser">
          <h3>{language.t("settings.browser.title")}</h3>
          <BrowserTab />
        </Tabs.Content>
        {/* <Tabs.Content value="autocomplete">
          <h3>{language.t("settings.autocomplete.title")}</h3>
          <AutocompleteTab />
        </Tabs.Content> */}
        <Tabs.Content value="notifications">
          <h3>{language.t("settings.notifications.title")}</h3>
          <NotificationsTab />
        </Tabs.Content>
        <Tabs.Content value="context">
          <h3>{language.t("settings.context.title")}</h3>
          <ContextTab />
        </Tabs.Content>
        <Tabs.Content value="memorySettings">
          <h3>记忆设置</h3>
          <MemorySettingTab
            onDirtyChange={setMemoryDirty}
            onSaveReady={(fn) => { memSave = fn }}
            onDiscardReady={(fn) => { memDiscard = fn }}
          />
        </Tabs.Content>
        <Tabs.Content value="normalSetting">
          <h3>通用设置</h3>
          <NormalSettingTab />
        </Tabs.Content>
        {/* testagent_change start - expose experimental settings */}
        <Tabs.Content value="experimental">
          <h3>{language.t("settings.experimental.title")}</h3>
          <GoalTab />
        </Tabs.Content>
        {/* testagent_change end */}
      </Tabs>

      {/* Save bar — slides in when there are unsaved config or memory changes */}
      <Show when={isDirty() || memoryDirty()}>
        <div class="settings-save-bar-wrap">
          <Show when={saveError()}>
            {(err) => (
              <div class="settings-save-bar-error">
                <div
                  class="settings-save-bar-error-header"
                  onClick={() => setErrorExpanded((v) => !v)}
                  role="button"
                  aria-expanded={errorExpanded()}
                >
                  <span
                    class={`settings-save-bar-error-chevron${errorExpanded() ? " settings-save-bar-error-chevron-expanded" : ""
                      }`}
                  >
                    <Icon name="chevron-right" size="small" />
                  </span>
                  <span class="settings-save-bar-error-title">
                    {language.t("settings.saveBar.saveFailed")}:{" "}
                    <span class="settings-save-bar-error-firstline">{err().message}</span>
                  </span>
                </div>
                <Show when={errorExpanded()}>
                  <pre class="settings-save-bar-error-details">{err().details ?? err().message}</pre>
                </Show>
              </div>
            )}
          </Show>
          <div class="settings-save-bar">
            <span class="settings-save-bar-label">{language.t("settings.saveBar.unsavedChanges")}</span>
            <Button variant="ghost" size="small" onClick={handleDiscardAll} disabled={saving()}>
              {language.t("settings.saveBar.discard")}
            </Button>
            <Button variant="primary" size="small" onClick={handleSaveAll} disabled={saving()}>
              {saving() ? language.t("settings.saveBar.saving") : language.t("settings.saveBar.save")}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default Settings
