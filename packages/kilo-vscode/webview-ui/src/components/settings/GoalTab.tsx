import type { Component } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { Switch } from "@kilocode/kilo-ui/switch"
import { WandSparkles } from "@kilocode/kilo-ui/lucide"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import SettingsRow from "./SettingsRow"

export const GoalIcon: Component = () => (
  <span data-component="icon" data-size="normal">
    <WandSparkles data-slot="icon-svg" size={20} aria-hidden="true" />
  </span>
)

const GoalTab: Component = () => {
  const { config, updateConfig } = useConfig()
  const language = useLanguage()

  const experimental = () => config().experimental ?? {}

  const updateExperimental = (key: string, value: unknown) => {
    updateConfig({
      experimental: { ...experimental(), [key]: value },
    })
  }

  return (
    <Card>
      <SettingsRow
        title={language.t("settings.goal.goal.title")}
        description={language.t("settings.goal.goal.description")}
      >
        <Switch
          checked={config().goal?.enabled ?? false}
          onChange={(checked) => {
            updateConfig({
              goal: {
                ...config().goal,
                enabled: checked,
              },
            })
          }}
          hideLabel
        >
          {language.t("settings.goal.goal.title")}
        </Switch>
      </SettingsRow>

      {/* testagent_change start - Agent Manager toggle */}
      {/*<SettingsRow*/}
      {/*  title={language.t("settings.goal.agentManager.title")}*/}
      {/*  description={language.t("settings.goal.agentManager.description")}*/}
      {/*  last*/}
      {/*>*/}
      {/*  <Switch*/}
      {/*    checked={experimental().agent_manager ?? false}*/}
      {/*    onChange={(checked) => updateExperimental("agent_manager", checked)}*/}
      {/*    hideLabel*/}
      {/*  >*/}
      {/*    {language.t("settings.goal.agentManager.title")}*/}
      {/*  </Switch>*/}
      {/*</SettingsRow>*/}
      {/* testagent_change end */}
    </Card>
  )
}

export default GoalTab
