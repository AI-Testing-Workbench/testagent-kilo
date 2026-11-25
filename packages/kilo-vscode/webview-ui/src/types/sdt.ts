// testagent_change - new file
export type SdtStageStatus =
  | "pending"
  | "executing"
  | "awaiting_access"
  | "awaiting_check"
  | "completed"
  | "skipped"
  | "exception"
  | "user_abort"

export interface SdtStage {
  stage_id: string
  stage_name: string
  status: SdtStageStatus
  status_text: string
  /** 开始执行时间：memory 里的 "YYYY-MM-DD HH:mm:ss" 字符串，简单命令上报毫秒时间戳 */
  execute_start_time?: string | number | null
  /** 结束执行时间：同上；执行中为 null */
  execute_end_time?: string | number | null
  /** 本阶段 AI 输入 token（未采集时为 null/缺省） */
  token_input?: number | null
  /** 本阶段 AI 输出 token（未采集时为 null/缺省） */
  token_output?: number | null
}

export interface SdtProgressState {
  sessionID: string
  runID: string
  taskName: string
  /** 本次执行所属的 testflow branch（缺省 default） */
  branch?: string | null
  status: "starting" | "running" | "completed" | "failed" | "aborted"
  sequence: number
  startedAt: number
  finishedAt?: number
  totalCount: number
  completedCount: number
  percent: number
  currentStageID: string | null
  currentStageIndex: number | null
  stages: SdtStage[]
  nextHint: string | null
  exceptionHint: string | null
  errorMessage: string | null
  detail: string | null
}

export interface SdtStartedMessage {
  type: "sdt.started"
  sessionID: string
  runID: string
  taskName: string
  startedAt: number
}

export interface SdtProgressMessage {
  type: "sdt.progress"
  sessionID: string
  runID: string
  sequence: number
  taskName: string
  branch?: string | null
  totalCount: number
  completedCount: number
  percent: number
  currentStageID: string | null
  currentStageIndex: number | null
  stages: SdtStage[]
  nextHint: string | null
  exceptionHint: string | null
  errorMessage: string | null
}

export interface SdtFinishedMessage {
  type: "sdt.finished"
  sessionID: string
  runID: string
  status: "completed" | "failed" | "aborted"
  finishedAt: number
  taskName: string
  totalCount: number
  currentStageID: string | null
  currentStageIndex: number | null
  completedCount: number
  percent: number
  stages: SdtStage[]
  detail: string | null
  errorMessage: string | null
}
