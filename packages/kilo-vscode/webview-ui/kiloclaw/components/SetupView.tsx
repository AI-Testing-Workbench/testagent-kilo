// KiloClaw setup view — shown when no instance is provisioned

import { useClaw } from "../context/claw"
import { useKiloClawLanguage } from "../context/language"

export function SetupView() {
  const claw = useClaw()
  const { t } = useKiloClawLanguage()

  return (
    <div class="kiloclaw-center">
      <div class="kiloclaw-card">
        <h2 class="kiloclaw-card-title">{t("kiloClaw.setup.title")}</h2>
        <h3 class="kiloclaw-card-subtitle">{t("kiloClaw.setup.subtitle")}</h3>
        <p class="kiloclaw-card-text">{t("kiloClaw.setup.description1")}</p>
        <p class="kiloclaw-card-text">{t("kiloClaw.setup.description2")}</p>
        <div class="kiloclaw-card-actions">
          <button class="kiloclaw-link-btn" onClick={() => claw.openExternal("https://kilo.ai/kiloclaw")}>
            {t("kiloClaw.setup.learnMore")}
          </button>
          <button class="kiloclaw-primary-btn" onClick={() => claw.openExternal("https://app.kilo.ai/claw")}>
            {t("kiloClaw.setup.tryKiloClaw")}
          </button>
        </div>
      </div>
    </div>
  )
}
