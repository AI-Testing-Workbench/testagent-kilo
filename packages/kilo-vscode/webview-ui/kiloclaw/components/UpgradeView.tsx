// KiloClaw upgrade view — shown when instance needs upgrade for chat

import { useClaw } from "../context/claw"
import { useKiloClawLanguage } from "../context/language"

export function UpgradeView() {
  const claw = useClaw()
  const { t } = useKiloClawLanguage()

  return (
    <div class="kiloclaw-center">
      <div class="kiloclaw-card">
        <h2 class="kiloclaw-card-title">{t("kiloClaw.upgrade.title")}</h2>
        <p class="kiloclaw-card-text">{t("kiloClaw.upgrade.description1")}</p>
        <p class="kiloclaw-card-text">
          {t("kiloClaw.upgrade.description2.before")}
          <strong>{t("kiloClaw.upgrade.description2.bold")}</strong>
          {t("kiloClaw.upgrade.description2.after")}
        </p>
        <div class="kiloclaw-card-actions">
          <div />
          <button class="kiloclaw-primary-btn" onClick={() => claw.openExternal("https://app.kilo.ai/claw")}>
            {t("kiloClaw.upgrade.openDashboard")}
          </button>
        </div>
      </div>
    </div>
  )
}
