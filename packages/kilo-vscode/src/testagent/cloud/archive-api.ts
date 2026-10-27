// testagent_change - new file
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { ServerConfig } from "../../services/cli-backend/types"
import { writeAtomic } from "./atomic"
import { ensureCloudWorkspace } from "./workspace"

export type SessionArchive = {
  info: { id: string; [key: string]: unknown }
  messages: unknown[]
  [key: string]: unknown
}

export type ArchiveContext = { directory: string; workspace?: string }

export type ArchiveImportResult = {
  sourceSessionID: string
  sessionID: string
  forked: boolean
}

export type CoreArchiveAccess = {
  connect: (dir: string) => Promise<unknown>
  config: () => ServerConfig | null
}

export type CoreArchiveConnection = {
  getClientAsync: (dir?: string) => Promise<unknown>
  getServerConfig: () => ServerConfig | null
}

export class CoreArchiveError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_context"
      | "not_connected"
      | "request_failed"
      | "http_error"
      | "invalid_response"
      | "session_mismatch",
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CoreArchiveError"
  }
}

export class CoreArchiveApi {
  constructor(
    private readonly access: CoreArchiveAccess,
    private readonly send: typeof fetch = fetch,
  ) {}

  async exportArchive(sessionID: string, ctx: ArchiveContext): Promise<SessionArchive> {
    // testagent_change start - recover archives from the core's canonical session endpoints
    const response = await this.request("GET", sessionID, "export", ctx).catch((err: unknown) => {
      if (err instanceof CoreArchiveError && err.code === "http_error" && err.status === 404) return undefined
      throw err
    })
    const body: unknown = await response?.json().catch(() => undefined)
    const archive = asArchive(body) ? (body as SessionArchive) : await this.exportFromSession(sessionID, ctx)
    // testagent_change end
    if (archive.info.id !== sessionID) throw new CoreArchiveError("导出的会话 ID 与请求中的会话 ID 不一致", "session_mismatch")
    return archive
  }

  preserveArchive(archive: SessionArchive, ctx: ArchiveContext): Promise<ArchiveImportResult> {
    return this.importArchive(archive, "import", ctx)
  }

  forkArchive(archive: SessionArchive, ctx: ArchiveContext): Promise<ArchiveImportResult> {
    return this.importArchive(archive, "import/fork", ctx)
  }

  private async importArchive(
    value: unknown,
    route: "import" | "import/fork",
    ctx: ArchiveContext,
  ): Promise<ArchiveImportResult> {
    const archive = parseSessionArchive(value)
    const response = await this.request("POST", archive.info.id, route, ctx, archive)
    const body: unknown = await response.json().catch(() => undefined)
    const result = asImportResult(body)
    if (!result) throw new CoreArchiveError("云端会话导入响应无效", "invalid_response")
    return result
  }

  // testagent_change start - rebuild unavailable or incompatible archive responses from core session endpoints
  private async exportFromSession(sessionID: string, ctx: ArchiveContext): Promise<SessionArchive> {
    const [info, messages] = await Promise.all([
      this.request("GET", sessionID, undefined, ctx).then((response) => response.json().catch(() => undefined)),
      this.request("GET", sessionID, "message", ctx).then((response) => response.json().catch(() => undefined)),
    ])
    return parseSessionArchive({ info, messages })
  }
  // testagent_change end

  private async request(
    method: "GET" | "POST",
    sessionID: string,
    route: "export" | "message" | "import" | "import/fork" | undefined,
    ctx: ArchiveContext,
    body?: SessionArchive,
  ): Promise<Response> {
    if (!sessionID || !ctx.directory) throw new CoreArchiveError("云端会话请求缺少会话 ID 或工作目录", "invalid_context")
    await this.access.connect(ctx.directory).catch((err) => {
      throw new CoreArchiveError("无法连接本地核心服务", "not_connected", undefined, err)
    })
    const cfg = await Promise.resolve()
      .then(() => this.access.config())
      .catch((err) => {
        throw new CoreArchiveError("无法读取本地核心服务配置", "not_connected", undefined, err)
      })
    if (!cfg) throw new CoreArchiveError("本地核心服务尚未连接", "not_connected")

    const url = makeUrl(cfg, sessionID, route)
    if (ctx.workspace) url.searchParams.set("workspace", ctx.workspace)
    const headers = new Headers({
      Authorization: `Basic ${Buffer.from(`opencode:${cfg.password}`).toString("base64")}`,
      Accept: "application/json",
      "x-opencode-directory": encodeURIComponent(ctx.directory),
    })
    if (body) headers.set("Content-Type", "application/json")
    const raw = body ? serializeArchive(body) : undefined
    const response = await this.send(url, {
      method,
      headers,
      body: raw,
    }).catch((err) => {
      throw new CoreArchiveError("请求本地会话 API 失败", "request_failed", undefined, err)
    })
    if (!response.ok)
      throw new CoreArchiveError(
        `本地会话请求失败，HTTP 状态码 ${response.status}`,
        "http_error",
        response.status,
      )
    return response
  }
}

export function createCoreArchiveApi(connection: CoreArchiveConnection) {
  return new CoreArchiveApi({
    connect: (dir) => connection.getClientAsync(dir),
    config: () => connection.getServerConfig(),
  })
}

function makeUrl(cfg: ServerConfig, id: string, route?: string): URL {
  try {
    return new URL(
      `session/${encodeURIComponent(id)}${route ? `/${route}` : ""}`,
      `${cfg.baseUrl.replace(/\/+$/, "")}/`,
    )
  } catch (err) {
    throw new CoreArchiveError("本地会话 API 地址无效", "invalid_context", undefined, err)
  }
}

function serializeArchive(archive: SessionArchive): string {
  try {
    return JSON.stringify(archive)
  } catch (err) {
    throw new CoreArchiveError("无法序列化云端会话", "invalid_response", undefined, err)
  }
}

export async function exportSessionArchive(
  dir: string,
  api: CoreArchiveApi,
  sessionID: string,
  ctx: ArchiveContext,
): Promise<{ archive: SessionArchive; name: string; file: string }> {
  const workspace = await ensureCloudWorkspace(dir)
  const archive = await api.exportArchive(sessionID, ctx)
  const raw = `${JSON.stringify(archive, null, 2)}\n`
  const sid = createHash("sha256").update(archive.info.id).digest("hex").slice(0, 16)
  const rev = createHash("sha256").update(raw).digest("hex").slice(0, 16)
  const name = `${sid}-${rev}.json`
  const file = path.join(workspace.export, name)
  await writeAtomic(file, raw)
  return { archive, name, file }
}

export function parseSessionArchive(value: unknown): SessionArchive {
  const archive = asArchive(value)
  if (!archive) throw new CoreArchiveError("云端会话格式无效", "invalid_response")
  return archive
}

function asArchive(value: unknown): SessionArchive | undefined {
  const data = record(value)
  const info = record(data?.info)
  if (!data || !info || typeof info.id !== "string" || !info.id || !Array.isArray(data.messages)) return undefined
  return value as SessionArchive
}

function asImportResult(value: unknown): ArchiveImportResult | undefined {
  const data = record(value)
  if (
    !data ||
    typeof data.sourceSessionID !== "string" ||
    typeof data.sessionID !== "string" ||
    typeof data.forked !== "boolean"
  ) {
    return undefined
  }
  return value as ArchiveImportResult
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
