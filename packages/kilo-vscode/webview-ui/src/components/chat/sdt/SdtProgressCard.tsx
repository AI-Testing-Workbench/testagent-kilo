// testagent_change - new file
import { Icon, type IconProps } from "@kilocode/kilo-ui/icon"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"
import type { SdtProgressState, SdtStage } from "../../../types/sdt"
import { LoadingSpinner } from "./LoadingSpinner"

interface SdtProgressCardProps {
  progress: SdtProgressState
  onDismiss?: () => void
}

/** 卡片内联错误的最大展示字符数，完整内容通过 title 悬浮查看 */
const ERROR_LIMIT = 200

/** 把 memory 的 "YYYY-MM-DD HH:mm:ss" 或毫秒时间戳统一转成毫秒 */
const toMs = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const ms = new Date(value.includes("T") ? value : value.replace(" ", "T")).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** 毫秒 → 紧凑耗时文案：45s / 3m20s / 1h05m */
const fmtDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`
  return `${seconds}s`
}

/** token 数 → 1.2k / 3.4m 缩写 */
const fmtTokens = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return `${count}`
}

const stageIcon = (status: SdtProgressState["stages"][number]["status"]): IconProps["name"] => {
  if (status === "pending") return "history"
  if (status === "awaiting_access") return "shield"
  if (status === "executing") return "reset"
  if (status === "awaiting_check") return "review"
  if (status === "completed") return "circle-check"
  if (status === "skipped") return "dash"
  if (status === "exception" || status === "user_abort") return "circle-x"
  return "dash"
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
  const [exiting, setExiting] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const hasRunning = createMemo(() =>
    props.progress.stages.some(
      (stage) => stage.status === "executing" || stage.status === "awaiting_access" || stage.status === "awaiting_check",
    ),
  )
  // 有阶段在执行时每秒刷新一次，让耗时实时走字
  createEffect(() => {
    if (!hasRunning()) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const duration = (stage: SdtStage): number | null => {
    // 待开始阶段不展示任何历史执行记录
    if (stage.status === "pending") return null
    const start = toMs(stage.execute_start_time)
    if (start === null) return null
    const end = toMs(stage.execute_end_time) ?? (hasRunning() ? now() : null)
    if (end === null) return null
    return Math.max(0, end - start)
  }
  // null 表示没有可展示的 token：待开始/执行中不展示，终态且未采集到则展示 "--"
  const tokenInfo = (stage: SdtStage): { input: number; output: number } | null => {
    if (stage.status === "pending") return null
    if (stage.token_input == null && stage.token_output == null) return null
    return { input: stage.token_input ?? 0, output: stage.token_output ?? 0 }
  }
  const missing = (stage: SdtStage): boolean =>
    ["completed", "exception", "user_abort"].includes(stage.status) &&
    stage.token_input == null &&
    stage.token_output == null

  const handleDismiss = () => {
    setExiting(true)
    setTimeout(() => {
      props.onDismiss?.()
      setExiting(false)
    }, 500)
  }
  
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
  const errorFull = createMemo(() => {
    const msg = props.progress.errorMessage ?? props.progress.exceptionHint
    return msg?.trim()
  })
  // 卡片只展示截断后的摘要，完整错误通过 title 悬浮查看
  const errorMessage = createMemo(() => {
    const msg = errorFull()
    if (!msg) return undefined
    return msg.length > ERROR_LIMIT ? `${msg.slice(0, ERROR_LIMIT)}…` : msg
  })
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
  const stageCount = () => {
    const completed = props.progress.completedCount
    // 优先判断任务状态：如果任务已经终止（completed/failed/aborted），直接返回已完成数
    if (props.progress.status === "completed" || props.progress.status === "failed" || props.progress.status === "aborted") {
      return completed
    }
    // 如果有正在执行的阶段（currentStageIndex 有值），说明当前有 1 个阶段在执行
    // 所以总共应该显示：已完成数 + 1
    if (props.progress.currentStageIndex !== null && props.progress.currentStageIndex > 0) {
      return completed + 1
    }
    // 如果还在运行中且还有未完成的阶段，显示下一个要执行的
    if (completed < props.progress.totalCount) {
      return completed + 1
    }
    return props.progress.totalCount
  }
  const isActive = createMemo(() => {
    if (props.progress.status !== "starting" && props.progress.status !== "running") return false
    return currentStage() !== undefined
  })

  return (
    <section
      class="sdt-progress-card"
      classList={{
        "sdt-progress-card--terminal": props.progress.status !== "starting" && props.progress.status !== "running",
        "sdt-progress-card--exiting": exiting(),
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
          <Show when={props.progress.branch && props.progress.branch !== "default"}>
            {" · branch "}
            <code>{props.progress.branch!}</code>
          </Show>
        </span>
        <span class="sdt-progress-card__metrics">
          第 {stageCount()} / {props.progress.totalCount} 阶段 · {progress()}%
        </span>
        <Icon
          name="chevron-down"
          class="sdt-progress-card__chevron"
          classList={{ "sdt-progress-card__chevron--expanded": expanded() }}
        />
        <Show when={props.onDismiss}>
          <button
            class="sdt-progress-card__close"
            type="button"
            title="关闭面板"
            onClick={(e) => {
              e.stopPropagation()
              handleDismiss()
            }}
          >
            <Icon name="close" style={{ width: '14px', height: '14px' }} />
          </button>
        </Show>
        <span class="sdt-progress-card__stage-summary">{currentStageLabel()}</span>
        <Show when={errorMessage()}>
          <span class="sdt-progress-card__error" title={errorFull()!}>
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
                <Show
                  when={stage.status === "executing"}
                  fallback={<Icon name={stageIcon(stage.status)} class="sdt-progress-card__stage-icon" />}
                >
                  <LoadingSpinner class="sdt-progress-card__stage-icon" />
                </Show>
                <span class="sdt-progress-card__stage-name" title={`${stage.stage_name}(${stage.stage_id})`}>
                  {stage.stage_name}({stage.stage_id})
                </span>
                <span class="sdt-progress-card__stage-metrics">
                  <Show when={duration(stage) !== null}>
                    <span class="sdt-progress-card__stage-duration">{fmtDuration(duration(stage)!)}</span>
                  </Show>
                  <Show
                    when={tokenInfo(stage)}
                    fallback={
                      <Show when={missing(stage)}>
                        <span class="sdt-progress-card__stage-tokens" title="未采集到 token 消耗">
                          --
                        </span>
                      </Show>
                    }
                  >
                    {(info) => (
                      <span
                        class="sdt-progress-card__stage-tokens"
                        title={`输入 ${info().input} / 输出 ${info().output} tokens`}
                      >
                        ↑{fmtTokens(info().input)} ↓{fmtTokens(info().output)}
                      </span>
                    )}
                  </Show>
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
