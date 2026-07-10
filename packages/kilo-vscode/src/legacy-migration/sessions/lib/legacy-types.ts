export interface LegacyHistoryItem {
  id: string
  rootTaskId?: string
  parentTaskId?: string
  ts?: number
  task?: string
  workspace?: string
  mode?: string
}

interface LegacyMessageParam {
  role: string
  content: string | unknown[]
}

export type LegacyApiMessage = LegacyMessageParam & {
  ts?: number
  isSummary?: boolean
  id?: string
  type?: "reasoning"
  summary?: unknown[]
  encrypted_content?: string
  text?: string
  reasoning_details?: unknown[]
  reasoning_content?: string
  condenseId?: string
  condenseParent?: string
  truncationId?: string
  truncationParent?: string
  isTruncationMarker?: boolean
}
