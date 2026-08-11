/**
 * RevertConfirmDock component
 * Shows when the user requests a checkpoint reset, blocking prompt input
 * until they confirm. Red border + light red background to signal danger.
 */

import { Component, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"

export const RevertConfirmDock: Component = () => {
  const session = useSession()
  const language = useLanguage()

  return (
    <Show when={session.revertConfirm()}>
      <div class="revert-confirm-dock" data-component="revert-confirm-dock">
        <div class="revert-confirm-dock-content">
          <Icon name="warning" size="small" />
          <span class="revert-confirm-dock-text">{language.t("revert.confirm.warning")}</span>
        </div>
        <div class="revert-confirm-dock-actions">
          <Button variant="ghost" size="small" onClick={() => session.cancelRevert()}>
            {language.t("revert.confirm.cancel")}
          </Button>
          <Button variant="primary" size="small" onClick={() => session.confirmRevert()}>
            {language.t("revert.confirm.confirm")}
          </Button>
        </div>
      </div>
    </Show>
  )
}
