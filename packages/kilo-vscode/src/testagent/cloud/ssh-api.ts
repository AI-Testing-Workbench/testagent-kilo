// testagent_change - new file
import * as vscode from "vscode"

export const REMOTE_SSH_EXTENSION_ID = "test-tech.tscode-remote-ssh"
export const REMOTE_SSH_MIN_VERSION = "1.2.0"

export type ContainerConfigEntry = {
  serviceId: string
  host: string
  name?: string
  hostName?: string
  port?: number
  expiresAt?: number | string
}

export type ContainerCreateRequest = {
  plugin_id: string
  type: "testagent_cloud"
  gitee_user: string
  gitee_repository: string
  gitee_branch: string
  gitee_url: string
  callbacks: {
    containerPrepared: (container: ContainerConfigEntry) => void | Promise<unknown>
  }
}

export type ContainerCreateResult = {
  service_id: string
  status: string
  type?: string
  endpoint?: string
  expires_at?: string
}

export type ContainerCreateOptions = {
  initializationSignal?: AbortSignal
  showNotifications?: boolean
}

export type ContainerStatusResult = {
  service_id: string
  status: string
  gitee_user: string
  gitee_repository: string
  gitee_url?: string
  gitee_branch?: string
  git_fin_status?: string
}

export type ContainerFileSyncResult = {
  direction: "upload" | "download"
  copied: number
  skipped: number
  deleted: number
  bytesTransferred: number
  complete: boolean
}

export type RemoteSshApi = {
  revealSidebar: () => Promise<void>
  createContainer: (request: ContainerCreateRequest, options?: ContainerCreateOptions) => Promise<ContainerCreateResult>
  getContainer: (serviceId: string) => Promise<ContainerStatusResult>
  syncFiles: (
    source: string,
    target: string,
    conflict: "overwrite" | "skip",
    mirror: boolean,
    container?: ContainerConfigEntry,
  ) => Promise<ContainerFileSyncResult>
  deleteContainer: (serviceId: string) => Promise<void>
}

const warned = new Set<string>()

export function remoteSshVersionSupported(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return false
  const nums = match.slice(1, 4).map(Number)
  const min = REMOTE_SSH_MIN_VERSION.split(".").map(Number)
  const i = nums.findIndex((part, idx) => part !== min[idx])
  if (i >= 0) return (nums[i] ?? 0) > (min[i] ?? 0)
  return !match[4]
}

export function isMissingService(value: unknown): boolean {
  const seen = new Set<unknown>()
  const stack = [value]
  while (stack.length) {
    const item = stack.pop()
    if (!item || typeof item !== "object" || seen.has(item)) continue
    seen.add(item)
    const data = item as Record<string, unknown>
    if (data.statusCode === 404 || data.statusCode === 410) return true
    if (data.code === "service_not_found" || data.code === "container_not_found" || data.code === "service_deleted") {
      return true
    }
    if (data.cause) stack.push(data.cause)
    if (data.detail) stack.push(data.detail)
    if (data.originalError) stack.push(data.originalError)
  }
  return false
}

export function formatCloudError(value: unknown, seen = new Set<Error>()): string {
  if (!(value instanceof Error)) {
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  if (seen.has(value)) return `${value.name}: ${value.message}`
  seen.add(value)
  const data = value as Error & {
    cause?: unknown
    detail?: unknown
    code?: unknown
    statusCode?: unknown
    serviceId?: unknown
  }
  const more = data.detail ?? data.cause
  const meta = [
    data.code === undefined ? undefined : `code=${String(data.code)}`,
    data.statusCode === undefined ? undefined : `status=${String(data.statusCode)}`,
    data.serviceId === undefined ? undefined : `serviceId=${String(data.serviceId)}`,
  ]
    .filter((item): item is string => !!item)
    .join(" ")
  return [
    `${value.name}: ${value.message}${meta ? ` (${meta})` : ""}`,
    value.stack,
    more === undefined ? undefined : `Caused by: ${formatCloudError(more, seen)}`,
  ]
    .filter((item): item is string => !!item)
    .join("\n")
}

export class RemoteSshApiError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
    readonly code: "unavailable" | "outdated" = "unavailable",
  ) {
    super(message)
    this.name = "RemoteSshApiError"
  }
}

export function isRemoteSshOutdated(value: unknown): boolean {
  const seen = new Set<unknown>()
  const stack = [value]
  while (stack.length) {
    const item = stack.pop()
    if (!item || typeof item !== "object" || seen.has(item)) continue
    seen.add(item)
    if (item instanceof RemoteSshApiError && item.code === "outdated") return true
    const data = item as Record<string, unknown>
    if (data.cause) stack.push(data.cause)
    if (data.detail) stack.push(data.detail)
    if (data.originalError) stack.push(data.originalError)
  }
  return false
}

export async function loadRemoteSshApi(): Promise<RemoteSshApi> {
  const extension = vscode.extensions.getExtension<RemoteSshApi>(REMOTE_SSH_EXTENSION_ID)
  if (!extension) throw new RemoteSshApiError("未安装工作台的 TSCode Remote 扩展")
  const version = typeof extension.packageJSON.version === "string" ? extension.packageJSON.version : "未知版本"
  if (!remoteSshVersionSupported(version)) {
    if (!warned.has(version)) {
      warned.add(version)
      void vscode.window.showWarningMessage(
        `工作台 TSCode Remote 扩展版本过旧 (当前版本 ${version}，最低要求 ${REMOTE_SSH_MIN_VERSION})，请先升级扩展。`,
        { modal: true },
        "确定",
      )
    }
    throw new RemoteSshApiError(
      `工作台 TSCode Remote 扩展需要 ${REMOTE_SSH_MIN_VERSION} 或更高版本`,
      { version },
      "outdated",
    )
  }
  try {
    const api = await extension.activate()
    return api
  } catch (err) {
    throw new RemoteSshApiError("启动工作台的 TSCode Remote 扩展失败", err)
  }
}
// testagent_change end
