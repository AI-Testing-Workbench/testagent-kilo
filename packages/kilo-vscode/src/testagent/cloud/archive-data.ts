// testagent_change - new file: validate native archive data for read-only shared rendering
import type { Message, Part, Session, SessionStatus, SnapshotFileDiff } from "@kilocode/sdk/v2"

export type CloudArchiveMessage = { info: Message; parts: Part[] }

export type CloudArchiveData = {
  info: Session
  messages: CloudArchiveMessage[]
}

export type CloudArchiveSummary = {
  key: string
  sessionID: string
  title: string
  createdAt: number
  updatedAt: number
  serviceId?: string
}

export type CloudArchiveTurnData = {
  data: {
    session: Session[]
    session_status: Record<string, SessionStatus>
    session_diff: Record<string, SnapshotFileDiff[]>
    message: Record<string, Message[]>
    part: Record<string, Part[]>
  }
  messages: Message[]
  turns: Message[]
}

export class CloudArchiveDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CloudArchiveDataError"
  }
}

// testagent_change start - timestamps must be valid JavaScript dates for relative-date rendering
export function cloudArchiveData(value: unknown): CloudArchiveData {
  const archive = record(value)
  const info = record(archive?.info)
  const time = record(info?.time)
  if (
    !archive ||
    !info ||
    typeof info.id !== "string" ||
    typeof info.slug !== "string" ||
    typeof info.projectID !== "string" ||
    typeof info.directory !== "string" ||
    typeof info.title !== "string" ||
    typeof info.version !== "string" ||
    !timestamp(time?.created) ||
    !timestamp(time.updated) ||
    !Array.isArray(archive.messages)
  ) {
    throw new CloudArchiveDataError("云端会话缺少有效的会话信息")
  }

  const msgs = archive.messages.map((item) => message(item, info.id as string))
  if (new Set(msgs.map((item) => item.info.id)).size !== msgs.length) {
    throw new CloudArchiveDataError("云端会话包含重复的消息 ID")
  }
  return { info: info as unknown as Session, messages: msgs }
}
// testagent_change end

export function cloudArchiveTurnData(archive: CloudArchiveData): CloudArchiveTurnData {
  const msgs = [...archive.messages]
    .sort(
      (left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id),
    )
    .map((item) => item.info)
  return {
    data: {
      session: [archive.info],
      session_status: { [archive.info.id]: { type: "idle" } },
      session_diff: { [archive.info.id]: [] },
      message: { [archive.info.id]: msgs },
      part: Object.fromEntries(archive.messages.map((item) => [item.info.id, item.parts])),
    },
    messages: msgs,
    turns: msgs.filter((item) => item.role === "user"),
  }
}

// testagent_change start - validate native message/part shapes before mapping to shared UI data
function message(value: unknown, sessionID: string): CloudArchiveMessage {
  const data = record(value)
  const info = record(data?.info)
  if (!data || !info || !validInfo(info, sessionID)) throw new CloudArchiveDataError("云端会话包含无效消息")
  if (info.role === "user" && !validUser(info)) {
    throw new CloudArchiveDataError("云端会话包含不完整的用户消息")
  }
  if (info.role === "assistant" && !validAssistant(info)) {
    throw new CloudArchiveDataError("云端会话包含不完整的助手消息")
  }
  if (!Array.isArray(data.parts)) throw new CloudArchiveDataError("云端会话包含无效消息片段")
  const parts = data.parts.map((value) => part(value, sessionID, info.id as string))
  return { info: info as unknown as Message, parts }
}

function validInfo(info: Record<string, unknown>, sessionID: string) {
  const time = record(info.time)
  return (
    typeof info.id === "string" &&
    info.sessionID === sessionID &&
    (info.role === "user" || info.role === "assistant") &&
    timestamp(time?.created)
  )
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(new Date(value).getTime())
}

function validUser(info: Record<string, unknown>) {
  const model = record(info.model)
  return (
    typeof info.agent === "string" &&
    !!model &&
    typeof model.providerID === "string" &&
    typeof model.modelID === "string"
  )
}

function validAssistant(info: Record<string, unknown>) {
  const file = record(info.path)
  const token = record(info.tokens)
  return (
    typeof info.parentID === "string" &&
    typeof info.modelID === "string" &&
    typeof info.providerID === "string" &&
    typeof info.mode === "string" &&
    typeof info.agent === "string" &&
    !!file &&
    typeof file.cwd === "string" &&
    typeof file.root === "string" &&
    typeof info.cost === "number" &&
    !!token
  )
}

function part(value: unknown, sessionID: string, messageID: string): Part {
  const data = record(value)
  if (
    !data ||
    typeof data.id !== "string" ||
    data.sessionID !== sessionID ||
    data.messageID !== messageID ||
    typeof data.type !== "string"
  ) {
    throw new CloudArchiveDataError("云端会话包含无效消息片段")
  }
  return data as unknown as Part
}
// testagent_change end

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
