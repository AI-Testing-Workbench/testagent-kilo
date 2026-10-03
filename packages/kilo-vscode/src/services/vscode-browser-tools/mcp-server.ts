import * as http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A tool the bridge offers to the agent, already expressed in MCP terms.
 */
export type McpToolSpec = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Outcome of a tool call, expressed as MCP content blocks.
 */
export type McpToolResult = {
  content: Array<Record<string, unknown>>
  isError?: boolean
}

export type McpToolProvider = {
  list(): McpToolSpec[]
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult>
}

/**
 * Versions we are willing to negotiate. The client rejects an `initialize` result whose
 * version it does not know, so the requested version is only echoed when it is listed here.
 */
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]
const FALLBACK_VERSION = "2025-03-26"
const MAX_BODY_BYTES = 32 * 1024 * 1024

type JsonRpcMessage = {
  id?: unknown
  method?: unknown
  params?: unknown
}

class MethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = "MethodError"
  }
}

/**
 * Minimal stateless MCP server speaking the Streamable HTTP transport.
 *
 * Hand written on purpose: `@modelcontextprotocol/sdk` is a dependency of the CLI, not of
 * this extension, and the surface we need is three JSON-RPC methods over one POST endpoint.
 *
 * Only POST is served. The MCP client treats a 405 on GET as "no standalone stream", which
 * is the correct answer for a stateless server.
 */
export class McpHttpServer {
  private server: http.Server | undefined
  private endpoint: string | undefined

  constructor(
    private readonly provider: McpToolProvider,
    private readonly info: { name: string; version: string },
    private readonly path = "/mcp",
  ) {}

  /** Endpoint to hand to the CLI. Only valid between `start()` and `stop()`. */
  get url(): string | undefined {
    return this.endpoint
  }

  async start(): Promise<string> {
    if (this.endpoint) return this.endpoint

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error("[TestAgent] McpHttpServer: request failed", err)
        respond(res, 500, { error: "internal error" })
      })
    })
    server.on("clientError", (_err, socket) => socket.destroy())

    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => reject(err)
      server.once("error", fail)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", fail)
        resolve()
      })
    })

    const port = (server.address() as AddressInfo).port
    this.server = server
    this.endpoint = `http://127.0.0.1:${port}${this.path}`
    return this.endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    this.endpoint = undefined
    // Keep-alive sockets would otherwise hold `close()` open until they time out.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0]
    if (path !== this.path) {
      respond(res, 404, { error: "not found" })
      return
    }
    if (req.method !== "POST") {
      respondEmpty(res, 405)
      return
    }

    const body = await readBody(req)
    if (body === undefined) {
      respond(res, 400, { error: "unreadable request body" })
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      respond(res, 200, rpcError(null, -32700, "Parse error"))
      return
    }

    // A payload is either one message or a batch of them.
    const batch = Array.isArray(payload) ? payload : undefined
    const messages = batch ?? [payload]
    const controller = new AbortController()
    res.on("close", () => controller.abort())

    const replies: unknown[] = []
    for (const message of messages) {
      const reply = await this.dispatch(message, controller.signal)
      if (reply !== undefined) replies.push(reply)
    }

    // A payload made up of notifications has nothing to answer.
    if (replies.length === 0) {
      respondEmpty(res, 202)
      return
    }
    respond(res, 200, batch ? replies : replies[0])
  }

  private async dispatch(message: unknown, signal: AbortSignal): Promise<unknown | undefined> {
    if (!isRecord(message)) return rpcError(null, -32600, "Invalid Request")

    const request = message as JsonRpcMessage
    const method = request.method
    if (typeof method !== "string") return rpcError(null, -32600, "Invalid Request")

    // Notifications never get a JSON-RPC response, and none of them need handling.
    if (method.startsWith("notifications/")) return undefined

    const isRequest = request.id !== undefined && request.id !== null
    if (!isRequest) return undefined

    try {
      return { jsonrpc: "2.0", id: request.id, result: await this.invoke(method, request.params, signal) }
    } catch (err) {
      if (err instanceof MethodError) return rpcError(request.id, err.code, err.message)
      console.error(`[TestAgent] McpHttpServer: ${method} failed`, err)
      return rpcError(request.id, -32603, err instanceof Error ? err.message : String(err))
    }
  }

  private async invoke(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method === "initialize") {
      const requested = readString(params, "protocolVersion")
      return {
        protocolVersion: requested && SUPPORTED_VERSIONS.includes(requested) ? requested : FALLBACK_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: this.info.name, version: this.info.version },
      }
    }

    if (method === "ping") return {}

    if (method === "tools/list") {
      return { tools: this.provider.list().map(toWireTool) }
    }

    if (method === "tools/call") {
      const name = readString(params, "name")
      if (!name) throw new MethodError(-32602, "Invalid params: missing tool name")
      try {
        const result = await this.provider.call(name, readObject(params, "arguments"), signal)
        return result.isError ? { content: result.content, isError: true } : { content: result.content }
      } catch (err) {
        // Report tool failures in band so the model can react instead of losing the turn.
        return { content: [{ type: "text", text: `Error: ${describe(err)}` }], isError: true }
      }
    }

    throw new MethodError(-32601, `Method not found: ${method}`)
  }
}

/**
 * MCP requires `type: "object"` at the schema root, so the shape is normalised even though
 * VS Code tools already describe themselves with JSON Schema.
 */
function toWireTool(spec: McpToolSpec): Record<string, unknown> {
  const schema = spec.inputSchema
  return {
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    inputSchema: { ...schema, type: "object", properties: readObject(schema, "properties") },
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

function respondEmpty(res: http.ServerResponse, status: number): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { "content-length": 0 })
  res.end()
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false

    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => resolve(undefined))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const found = value[key]
  return typeof found === "string" ? found : undefined
}

function readObject(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const found = value[key]
  return isRecord(found) ? found : {}
}

function describe(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
