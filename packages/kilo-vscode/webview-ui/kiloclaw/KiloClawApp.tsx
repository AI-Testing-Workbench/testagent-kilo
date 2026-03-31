// KiloClaw root component

import { Show, Switch, Match } from "solid-js"
import { ThemeProvider } from "@kilocode/kilo-ui/theme"
import { ClawProvider, useClaw } from "./context/claw"
import { KiloClawLanguageProvider, useKiloClawLanguage } from "./context/language"
import { ChatPanel } from "./components/ChatPanel"
import { StatusSidebar } from "./components/StatusSidebar"
import { SetupView } from "./components/SetupView"
import { UpgradeView } from "./components/UpgradeView"

function Content() {
  const claw = useClaw()
  const { t } = useKiloClawLanguage()

  return (
    <div class="kiloclaw-root">
      <Switch>
        <Match when={claw.phase() === "loading"}>
          <div class="kiloclaw-center">
            <div class="kiloclaw-loading">
              <div class="kiloclaw-spinner" />
              <span>{t("kiloClaw.loading")}</span>
            </div>
          </div>
        </Match>
        <Match when={claw.phase() === "noInstance"}>
          <SetupView />
        </Match>
        <Match when={claw.phase() === "needsUpgrade"}>
          <UpgradeView />
        </Match>
        <Match when={claw.phase() === "ready"}>
          <div class="kiloclaw-layout">
            <ChatPanel />
            <StatusSidebar />
          </div>
        </Match>
      </Switch>
      <Show when={claw.error()}>
        <div class="kiloclaw-toast">{claw.error()}</div>
      </Show>
    </div>
  )
}

export function KiloClawApp() {
  return (
    <ThemeProvider>
      <ClawProvider>
        <LanguageBridge>
          <Content />
        </LanguageBridge>
      </ClawProvider>
    </ThemeProvider>
  )
}

/** Bridges the claw context locale into the language provider. Must be below ClawProvider. */
function LanguageBridge(props: { children: any }) {
  const claw = useClaw()
  return <KiloClawLanguageProvider locale={claw.locale}>{props.children}</KiloClawLanguageProvider>
}
