// testagent_change - new file
import { Icon, type IconProps } from "@kilocode/kilo-ui/icon"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { SdtProgressState } from "../../../types/sdt"

interface SdtProgressCardProps {
  progress: SdtProgressState
}

const stageIcon = (status: SdtProgressState["stages"][number]["status"]): IconProps["name"] => {
  if (status === "completed") return "circle-check"
  if (status === "skipped") return "dash"
  if (status === "exception" || status === "user_abort") return "circle-x"
  return "history"
}

const statusLabel = (status: SdtProgressState["status"]) => {
  if (status === "starting") return "正在启动"
  if (status === "running") return "执行中"
  if (status === "completed") return "已完成"
  if (status === "failed") return "执行失败"
  return "已终止"
}

export const SdtProgressCard: Component<SdtProgressCardProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const currentStage = createMemo(() => {
    const byID = props.progress.currentStageID
      ? props.progress.stages.find((stage) => stage.stage_id === props.progress.currentStageID)
      : undefined
    if (byID) return byID

    const index = props.progress.currentStageIndex
    if (index !== null && index >= 0) return props.progress.stages[index]

    return props.progress.stages.find(
      (stage) => !["completed", "skipped", "exception", "user_abort"].includes(stage.status),
    )
  })
  const errorMessage = createMemo(() => props.progress.errorMessage ?? props.progress.exceptionHint)
  const currentStageLabel = createMemo(() => {
    if (currentStage()) {
      return `当前阶段：${currentStage()!.stage_name}(${currentStage()!.stage_id}) · ${currentStage()!.status_text}`
    }
    if (props.progress.status === "completed") return "当前阶段：执行完成"
    if (props.progress.status === "failed") return "当前阶段：执行失败"
    if (props.progress.status === "aborted") return "当前阶段：已终止"
    return "当前阶段：等待执行"
  })
  const progress = () => Math.max(0, Math.min(100, props.progress.percent))
  const stageCount = () => props.progress.currentStageIndex ?? props.progress.completedCount
  const isActive = createMemo(() => {
    if (props.progress.status !== "starting" && props.progress.status !== "running") return false
    return currentStage() !== undefined
  })

  return (
    <section
      class="sdt-progress-card"
      classList={{
        "sdt-progress-card--terminal": props.progress.status !== "starting" && props.progress.status !== "running",
      }}
    >
      <button
        class="sdt-progress-card__summary"
        type="button"
        aria-expanded={expanded()}
        onClick={() => setExpanded((value) => !value)}
      >
        <span
          class="sdt-progress-card__indicator"
          classList={{
            "sdt-progress-card__indicator--running":
              props.progress.status === "starting" || props.progress.status === "running",
            [`sdt-progress-card__indicator--${props.progress.status}`]: true,
          }}
          aria-hidden="true"
        />
        <span class="sdt-progress-card__title">
          SDT 任务 · {statusLabel(props.progress.status)} · {props.progress.taskName}
        </span>
        <span class="sdt-progress-card__metrics">
          第 {stageCount()} / {props.progress.totalCount} 阶段 · {progress()}%
        </span>
        <Icon
          name="chevron-down"
          class="sdt-progress-card__chevron"
          classList={{ "sdt-progress-card__chevron--expanded": expanded() }}
        />
        <span class="sdt-progress-card__stage-summary">{currentStageLabel()}</span>
        <Show when={errorMessage()}>
          <span class="sdt-progress-card__error" title={errorMessage()!}>
            {errorMessage()}
          </span>
        </Show>
      </button>
      <div
        class="sdt-progress-card__bar"
        classList={{ "sdt-progress-card__bar--active": isActive() }}
        role="progressbar"
        aria-busy={isActive()}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progress()}
      >
        <span class="sdt-progress-card__bar-value" style={{ width: `${progress()}%` }} />
        <Show when={isActive()}>
          <span class="sdt-progress-card__bar-activity" aria-hidden="true" />
        </Show>
      </div>
      <Show when={expanded()}>
        <div class="sdt-progress-card__stages">
          <For each={props.progress.stages}>
            {(stage) => (
              <div class="sdt-progress-card__stage" classList={{ [`sdt-progress-card__stage--${stage.status}`]: true }}>
                <Icon
                  name={stageIcon(stage.status)}
                  class="sdt-progress-card__stage-icon"
                  classList={{
                    "sdt-progress-card__stage-icon--running":
                      stage.status === "executing" ||
                      stage.status === "awaiting_access" ||
                      stage.status === "awaiting_check",
                  }}
                />
                <span class="sdt-progress-card__stage-name" title={`${stage.stage_name}(${stage.stage_id})`}>
                  {stage.stage_name}({stage.stage_id})
                </span>
                <span class="sdt-progress-card__stage-status">{stage.status_text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
