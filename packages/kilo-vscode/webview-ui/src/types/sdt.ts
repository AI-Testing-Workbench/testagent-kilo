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
  execute_end_time: string | null
}

export interface SdtProgressState {
  sessionID: string
  runID: string
  taskName: string
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
