import { Component, createMemo, Switch, Match, Show } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { ErrorDetails } from "@kilocode/kilo-ui/error-details"
import { Button } from "@kilocode/kilo-ui/button"
import type { AssistantMessage } from "@kilocode/sdk/v2"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import {
  unwrapError,
  parseAssistantError,
  isUnauthorizedPaidModelError,
  isUnauthorizedPromotionLimitError,
  isDefaultAgentMissingError,
} from "../../utils/errorUtils"

interface ErrorDisplayProps {
  error: NonNullable<AssistantMessage["error"]>
  onLogin?: () => void
  onRetry?: () => void
}

export const ErrorDisplay: Component<ErrorDisplayProps> = (props) => {
  const { t } = useLanguage()
  const vscode = useVSCode()
  const parsed = createMemo(() => parseAssistantError(props.error))

  const errorText = createMemo(() => {
    const msg = props.error.data?.message
    if (typeof msg === "string") return unwrapError(msg)
    if (msg === undefined || msg === null) return ""
    return unwrapError(String(msg))
  })

  const agentMissing = createMemo(() => isDefaultAgentMissingError(errorText()))

  return (
    <Switch
      fallback={
        <Card variant="error" class="error-card">
          {errorText()}
          <Collapsible variant="ghost">
            <Collapsible.Trigger class="error-details-trigger">
              <span>{t("error.details.show")}</span>
              <Collapsible.Arrow />
            </Collapsible.Trigger>
            <Collapsible.Content>
              <ErrorDetails error={props.error} />
            </Collapsible.Content>
          </Collapsible>
        </Card>
      }
    >
      <Match when={agentMissing()}>
        <Card variant="error" class="error-card">
          {errorText()}
          <p>请打开配置文件，将 default_agent 改为已存在的智能体，或删除该项后重新选择。</p>
          <div data-slot="error-actions" style={{ display: "flex", gap: "8px", "margin-top": "8px" }}>
            <Button variant="primary" size="small" onClick={() => vscode.postMessage({ type: "openConfigFile", scope: "global" })}>
              打开全局配置文件
            </Button>
            <Button variant="secondary" size="small" onClick={() => vscode.postMessage({ type: "openConfigFile", scope: "local" })}>
              打开项目配置文件
            </Button>
          </div>
        </Card>
      </Match>
      <Match when={isUnauthorizedPaidModelError(parsed())}>
        <div data-component="auth-prompt">
          <div data-slot="auth-prompt-header">
            <span data-slot="auth-prompt-icon">✨</span>
            <span data-slot="auth-prompt-title">{t("error.paidModel.title")}</span>
          </div>
          <p data-slot="auth-prompt-description">{t("error.paidModel.description")}</p>
          <Button variant="primary" onClick={() => props.onLogin?.()}>
            {t("error.paidModel.action")}
          </Button>
        </div>
      </Match>
      <Match when={isUnauthorizedPromotionLimitError(parsed())}>
        <div data-component="auth-prompt">
          <div data-slot="auth-prompt-header">
            <span data-slot="auth-prompt-icon">🕙</span>
            <span data-slot="auth-prompt-title">{t("error.promotionLimit.title")}</span>
          </div>
          <p data-slot="auth-prompt-description">{t("error.promotionLimit.description")}</p>
          <Button variant="primary" onClick={() => props.onLogin?.()}>
            {t("error.promotionLimit.action")}
          </Button>
        </div>
      </Match>
    </Switch>
  )
}
