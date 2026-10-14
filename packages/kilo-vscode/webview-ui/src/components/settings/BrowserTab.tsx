import { Component, createSignal, onCleanup, onMount } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Card } from "@kilocode/kilo-ui/card"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import type { BrowserSettings } from "../../types/messages"
import SettingsRow from "./SettingsRow"

const BrowserTab: Component = () => {
  const { postMessage, onMessage } = useVSCode()
  const { t } = useLanguage()

  const [settings, setSettings] = createSignal<BrowserSettings>({
    enabled: false,
    useSystemChrome: true,
    headless: false,
    vscodeBrowserTools: false,
    cdpEndpoint: "",
    cdpEndpointEnv: "",
    cdpExternalEnv: "",
    vncUrl: "",
  })

  // Draft kept separate from settings: the endpoint is persisted on blur/Enter, not per keystroke,
  // so a long URL doesn't rewrite settings.json (and re-register the MCP) on every character.
  const [endpoint, setEndpoint] = createSignal("")

  onMount(() => {
    postMessage({ type: "requestBrowserSettings" })
  })

  // Subscribe outside onMount to catch early pushes (per AGENTS.md pattern)
  const unsubscribe = onMessage((msg) => {
    if (msg.type === "browserSettingsLoaded") {
      setSettings(msg.settings)
      setEndpoint(msg.settings.cdpEndpoint)
    }
  })
  onCleanup(unsubscribe)

  /**
   * The two backends are exclusive: each registers its own MCP server, and with both on the agent
   * would see two overlapping sets of browser tools. The extension clears the other one for real;
   * mirroring it here just avoids the switch sitting on until that round trip lands.
   */
  const update = (key: "enabled" | "useSystemChrome" | "headless", value: boolean) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "enabled" && value ? { vscodeBrowserTools: false } : {}),
    }))
    postMessage({ type: "updateSetting", key: `browserAutomation.${key}`, value })
  }

  const updateVscodeBrowserTools = (value: boolean) => {
    setSettings((prev) => ({ ...prev, vscodeBrowserTools: value, enabled: value ? false : prev.enabled }))
    postMessage({ type: "updateSetting", key: "vscodeBrowserTools.enabled", value })
  }

  const commitEndpoint = () => {
    if (endpoint() === settings().cdpEndpoint) return
    postMessage({ type: "updateSetting", key: "browserAutomation.cdpEndpoint", value: endpoint() })
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      {/* Info text */}
      <div
        style={{
          background: "var(--vscode-textBlockQuote-background)",
          border: "1px solid var(--vscode-panel-border)",
          "border-radius": "4px",
          padding: "12px 16px",
        }}
      >
        <p
          style={{
            "font-size": "12px",
            color: "var(--vscode-descriptionForeground)",
            margin: 0,
            "line-height": "1.5",
          }}
        >
          {t("settings.browser.description")}
        </p>
      </div>

      {/* Backend 1: VS Code's own browser. It has no sub-options, so it gets its own card. */}
      <Card>
        <SettingsRow
          title={t("settings.browser.vscodeTools.title")}
          description={t("settings.browser.vscodeTools.description")}
          last
        >
          <Switch checked={settings().vscodeBrowserTools} onChange={updateVscodeBrowserTools} hideLabel>
            {t("settings.browser.vscodeTools.title")}
          </Switch>
        </SettingsRow>
      </Card>

      {/* Backend 2: Playwright. Its options only mean anything while the switch above them is on,
          so they are indented beneath it and greyer out while it is off. */}
      <Card>
        <SettingsRow title={t("settings.browser.enable.title")} description={t("settings.browser.enable.description")}>
          <Switch checked={settings().enabled} onChange={(checked: boolean) => update("enabled", checked)} hideLabel>
            {t("settings.browser.enable.title")}
          </Switch>
        </SettingsRow>

        <div
          style={{
            "padding-left": "12px",
            "border-left": "2px solid var(--border-weak-base)",
            opacity: settings().enabled ? "1" : "0.5",
          }}
        >
          <div
            style={{
              "font-size": "11px",
              color: "var(--vscode-descriptionForeground)",
              "margin-bottom": "8px",
            }}
          >
            {t("settings.browser.playwrightOptions.title")}
          </div>

          {/* Use System Chrome */}
          <SettingsRow
            title={t("settings.browser.systemChrome.title")}
            description={t("settings.browser.systemChrome.description")}
          >
            <Switch
              checked={settings().useSystemChrome}
              onChange={(checked: boolean) => update("useSystemChrome", checked)}
              disabled={!settings().enabled}
              hideLabel
            >
              {t("settings.browser.systemChrome.title")}
            </Switch>
          </SettingsRow>

          {/* Headless mode */}
          <SettingsRow
            title={t("settings.browser.headless.title")}
            description={t("settings.browser.headless.description")}
          >
            <Switch
              checked={settings().headless}
              onChange={(checked: boolean) => update("headless", checked)}
              disabled={!settings().enabled}
              hideLabel
            >
              {t("settings.browser.headless.title")}
            </Switch>
          </SettingsRow>

          {/* Remote CDP endpoint: drives an existing browser (e.g. the shared sandbox Chrome on VNC)
              instead of launching a new one. */}
          <SettingsRow
            title={t("settings.browser.cdpEndpoint.title")}
            description={t("settings.browser.cdpEndpoint.description")}
          >
            <TextField
              value={endpoint()}
              onChange={setEndpoint}
              onBlur={commitEndpoint}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter") commitEndpoint()
              }}
              disabled={!settings().enabled}
              style={{ width: "100%" }}
            />
          </SettingsRow>

          {/* Read-only CDP env vars injected by the sandbox image. */}
          <SettingsRow title={t("settings.browser.cdp.title")} last>
            <div
              style={{
                "font-family": "var(--vscode-editor-font-family, monospace)",
                "font-size": "12px",
                color: "var(--vscode-descriptionForeground)",
                "word-break": "break-all",
                "line-height": "1.6",
              }}
            >
              {settings().cdpEndpointEnv || settings().cdpExternalEnv || settings().vncUrl ? (
                <>
                  {settings().cdpEndpointEnv && <div>{`TESTAGENT_CDP_ENDPOINT=${settings().cdpEndpointEnv}`}</div>}
                  {settings().cdpExternalEnv && <div>{`TESTAGENT_CDP_EXTERNAL=${settings().cdpExternalEnv}`}</div>}
                  {settings().vncUrl && <div>{`TESTAGENT_VNC_URL=${settings().vncUrl}`}</div>}
                </>
              ) : (
                <div>{t("settings.browser.cdp.notSet")}</div>
              )}
            </div>
          </SettingsRow>
        </div>
      </Card>
    </div>
  )
}

export default BrowserTab
