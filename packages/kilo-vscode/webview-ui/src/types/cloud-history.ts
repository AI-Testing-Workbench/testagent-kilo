// testagent_change - new file: typed cloud archive history request and response contracts
import type { CloudArchiveData, CloudArchiveSummary } from "../../../src/testagent/cloud/archive-data"

export interface CloudArchiveListLoadedMessage {
  type: "cloudArchiveListLoaded"
  archives: CloudArchiveSummary[]
  invalidCount: number
}

// testagent_change start - expose local repository eligibility for history navigation
export interface CloudArchiveAvailabilityMessage {
  type: "cloudArchiveAvailability"
  available: boolean
}
// testagent_change end

// testagent_change start - expose whether local sessions can target an existing sandbox
export interface CloudAppendAvailabilityMessage {
  type: "cloudAppendAvailability"
  available: boolean
}
// testagent_change end

export interface CloudArchiveLoadedMessage {
  type: "cloudArchiveLoaded"
  key: string
  archive: CloudArchiveData
}

export interface CloudArchiveForkedMessage {
  type: "cloudArchiveForked"
  key: string
  sourceSessionID: string
  sessionID: string
}

export interface CloudArchiveOperationFailedMessage {
  type: "cloudArchiveOperationFailed"
  operation: "list" | "read" | "fork"
  key?: string
}

export interface CloudActionProgressMessage {
  type: "cloudActionProgress"
  action: "upload" | "export"
  sessionID: string
  pending: boolean
  cancelled?: boolean
}

export interface RequestCloudArchiveListMessage {
  type: "requestCloudArchiveList"
  availabilityOnly?: true // testagent_change
}

export interface RequestCloudArchiveMessage {
  type: "requestCloudArchive"
  key: string
}

export interface RequestCloudArchiveForkMessage {
  type: "requestCloudArchiveFork"
  key: string
}

export interface RequestCloudUploadMessage {
  type: "requestCloudUpload"
  sessionID: string
  append?: true // testagent_change
}

export interface RequestCloudExportMessage {
  type: "requestCloudExport"
  sessionID: string
}

/* testagent_change start - the aggregate webview union is defined in messages.ts for contract validation
export type CloudHistoryWebviewMessage =
  | RequestCloudArchiveListMessage
  | RequestCloudArchiveMessage
  | RequestCloudArchiveForkMessage
  | RequestCloudUploadStatesMessage
  | RequestCloudUploadMessage
  | RequestCloudExportMessage
testagent_change end */

export type CloudHistoryExtensionMessage =
  | CloudArchiveListLoadedMessage
  | CloudArchiveAvailabilityMessage // testagent_change
  | CloudAppendAvailabilityMessage // testagent_change
  | CloudArchiveLoadedMessage
  | CloudArchiveForkedMessage
  | CloudArchiveOperationFailedMessage
  | CloudActionProgressMessage
