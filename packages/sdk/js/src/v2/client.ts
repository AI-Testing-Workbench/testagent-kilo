export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { KiloClient as GeneratedKiloClient } from "./gen/sdk.gen.js"
import type {
  Agent as GeneratedAgent,
  Event as GeneratedEvent,
  QuestionRequest as GeneratedQuestionRequest,
  Session as GeneratedSession,
} from "./gen/types.gen.js"
export { type Config as KiloClientConfig }
export const KiloClient = GeneratedKiloClient

export type Agent = GeneratedAgent & {
  displayName?: string
  deprecated?: boolean
}

export type QuestionRequest = GeneratedQuestionRequest & {
  blocking?: boolean
}

type CompatMessagePartDeltaEvent = {
  id: string
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
    partType?: string
  }
}

type CompatQuestionAskedEvent = {
  id: string
  type: "question.asked"
  properties: QuestionRequest
}

type CompatSuggestionEvent =
  | {
      id: string
      type: "suggestion.shown"
      properties: SuggestionRequest
    }
  | {
      id: string
      type: "suggestion.accepted" | "suggestion.dismissed"
      properties: {
        sessionID: string
        requestID: string
      }
    }

type CompatSessionInfoEvent = {
  id: string
  type: "session.info"
  properties: {
    sessionID?: string
    message: string
  }
}

type CompatRemoteEvent = {
  id: string
  type: "kilo-sessions.remote-status-changed"
  properties: {
    enabled: boolean
    connected: boolean
  }
}

type CompatGlobalConfigUpdatedEvent = {
  id: string
  type: "global.config.updated"
  properties: Record<string, unknown>
}

export type Event =
  | Exclude<GeneratedEvent, { type: "message.part.delta" | "question.asked" }>
  | CompatMessagePartDeltaEvent
  | CompatQuestionAskedEvent
  | CompatSuggestionEvent
  | CompatSessionInfoEvent
  | CompatRemoteEvent
  | CompatGlobalConfigUpdatedEvent

export type SuggestionRequest = {
  id: string
  sessionID: string
  text: string
  actions?: Array<{ label: string; value?: string }>
  blocking?: boolean
  tool?: unknown
}

type LegacyResult<T> = Promise<{ data?: T; error?: unknown }>
type LegacyDataResult<T> = Promise<{ data: T; error?: unknown }>
type LegacyOptions = {
  throwOnError?: boolean
  signal?: AbortSignal
  sseMaxRetryAttempts?: number
  onSseError?: (error: unknown) => void
  [key: string]: unknown
}
type LegacyBody = Record<string, unknown>
type LegacyStreamChunk = {
  choices?: Array<{ delta?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  cost?: number
}

type LegacyMessageData =
  | {
      role: "user"
      time: { created: number; completed?: number }
      agent: string
      model: { providerID: string; modelID: string }
    }
  | {
      role: "assistant"
      time: { created: number; completed?: number }
      parentID: string
      modelID: string
      providerID: string
      mode: string
      agent: string
      path: { cwd: string; root: string }
      cost: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: { read: number; write: number }
      }
    }

type LegacyPartData =
  | {
      type: "text"
      text: string
      ignored?: boolean
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }
  | {
      type: "reasoning"
      text: string
      time: { start: number; end: number }
    }
  | {
      type: "tool"
      callID: string
      tool: string
      state: {
        status: "completed"
        input: Record<string, unknown>
        output: string
        title: string
        metadata: Record<string, unknown>
        time: { start: number; end: number }
      }
    }

export type KilocodeSessionImportProjectData = {
  body?: {
    id: string
    worktree: string
    sandboxes: string[]
    timeCreated: number
    timeUpdated: number
  }
}

export type KilocodeSessionImportSessionData = {
  body?: {
    id: string
    projectID: string
    slug: string
    directory: string
    title: string
    version: string
    timeCreated: number
    timeUpdated: number
    query_directory?: string
    body_directory?: string
    force?: boolean
  }
}

export type KilocodeSessionImportMessageData = {
  body?: {
    id: string
    sessionID: string
    timeCreated: number
    data: LegacyMessageData
  }
}

export type KilocodeSessionImportPartData = {
  body?: {
    id: string
    messageID: string
    sessionID: string
    timeCreated: number
    data: LegacyPartData
  }
}

type RuntimeLegacyKiloClient = {
  kilo: {
    organization: {
      set(input?: { organizationId?: string | null }, options?: LegacyOptions): LegacyResult<boolean>
    }
    profile(input?: LegacyBody, options?: LegacyOptions): LegacyResult<{ balance?: { balance?: number } }>
    notifications(input?: LegacyBody, options?: LegacyOptions): LegacyResult<unknown[]>
    cloudSessions(
      input?: { cursor?: string; limit?: number; gitUrl?: string },
      options?: LegacyOptions,
    ): LegacyResult<{ cliSessions?: unknown[]; nextCursor?: string | null }>
    cloud: {
      session: {
        get(input: { id: string }, options?: LegacyOptions): LegacyResult<unknown>
        import(
          input: { sessionId: string; directory?: string },
          options?: LegacyOptions,
        ): LegacyResult<GeneratedSession>
      }
    }
    fim(
      input: { prefix: string; suffix: string; model: string; maxTokens?: number; temperature?: number },
      options?: LegacyOptions,
    ): Promise<{ stream: AsyncIterable<LegacyStreamChunk> }>
    claw: {
      status(input?: LegacyBody, options?: LegacyOptions): LegacyResult<Record<string, unknown>>
      chatCredentials(input?: LegacyBody, options?: LegacyOptions): LegacyResult<unknown>
    }
  }
  kilocode: {
    removeAgent(input: { name: string; directory?: string }, options?: LegacyOptions): LegacyResult<boolean>
    sessionImport: {
      project(
        input: NonNullable<KilocodeSessionImportProjectData["body"]>,
        options?: LegacyOptions,
      ): LegacyResult<{ id?: string }>
      session(
        input: NonNullable<KilocodeSessionImportSessionData["body"]>,
        options?: LegacyOptions,
      ): LegacyResult<{ id?: string; skipped?: boolean }>
      message(
        input: NonNullable<KilocodeSessionImportMessageData["body"]>,
        options?: LegacyOptions,
      ): LegacyResult<boolean>
      part(input: NonNullable<KilocodeSessionImportPartData["body"]>, options?: LegacyOptions): LegacyResult<boolean>
    }
  }
  remote: {
    status(input?: LegacyBody, options?: LegacyOptions): LegacyResult<{ enabled: boolean; connected: boolean }>
    enable(input?: LegacyBody, options?: LegacyOptions): LegacyResult<boolean>
    disable(input?: LegacyBody, options?: LegacyOptions): LegacyResult<boolean>
  }
  commitMessage: {
    generate(
      input: { path: string; selectedFiles?: string[]; previousMessage?: string },
      options?: LegacyOptions,
    ): LegacyDataResult<{ message: string }>
  }
  suggestion: {
    list(input?: { directory?: string }, options?: LegacyOptions): LegacyResult<SuggestionRequest[]>
    accept(
      input: { requestID: string; index: number; directory?: string },
      options?: LegacyOptions,
    ): LegacyResult<boolean>
    dismiss(input: { requestID: string; directory?: string }, options?: LegacyOptions): LegacyResult<boolean>
  }
}

type TypeOnlyLegacyKiloClient = {
  session: {
    create(
      input?: {
        directory?: string
        workspace?: string
        platform?: string
        parentID?: string
        title?: string
        agent?: string
        model?: { id: string; providerID: string; variant?: string }
        permission?: unknown
        workspaceID?: string
      },
      options?: LegacyOptions,
    ): LegacyDataResult<GeneratedSession>
    viewed(input: { focused: string[]; open: string[] }, options?: LegacyOptions): LegacyDataResult<boolean>
  }
  config: {
    warnings(
      input?: { directory?: string; workspace?: string },
      options?: LegacyOptions,
    ): LegacyDataResult<Array<{ path: string; message: string; detail?: string }>>
  }
}

export type KiloClient = GeneratedKiloClient & RuntimeLegacyKiloClient & TypeOnlyLegacyKiloClient

function ok<T>(data: T): LegacyResult<T> {
  return Promise.resolve({ data })
}

function unavailable<T>(name: string, options?: LegacyOptions): LegacyResult<T> {
  const error = new Error(`${name} is not available in this TestAgent backend`)
  if (options?.throwOnError) return Promise.reject(error)
  return Promise.resolve({ error })
}

function unavailableData<T>(name: string): LegacyDataResult<T> {
  return Promise.reject(new Error(`${name} is not available in this TestAgent backend`))
}

async function* emptyFimStream(): AsyncIterable<LegacyStreamChunk> {}

function legacyCompat(): RuntimeLegacyKiloClient {
  return {
    kilo: {
      organization: {
        set: () => ok(true),
      },
      profile: () => ok({ balance: { balance: 0 } }),
      notifications: () => ok([]),
      cloudSessions: () => ok({ cliSessions: [], nextCursor: null }),
      cloud: {
        session: {
          get: (_input, options) => unavailable("kilo.cloud.session.get", options),
          import: (_input, options) => unavailable("kilo.cloud.session.import", options),
        },
      },
      fim: async () => ({ stream: emptyFimStream() }),
      claw: {
        status: (_input, options) => unavailable("kilo.claw.status", options),
        chatCredentials: (_input, options) => unavailable("kilo.claw.chatCredentials", options),
      },
    },
    kilocode: {
      removeAgent: () => ok(false),
      sessionImport: {
        project: (_input, options) => unavailable("kilocode.sessionImport.project", options),
        session: (_input, options) => unavailable("kilocode.sessionImport.session", options),
        message: (_input, options) => unavailable("kilocode.sessionImport.message", options),
        part: (_input, options) => unavailable("kilocode.sessionImport.part", options),
      },
    },
    remote: {
      status: () => ok({ enabled: false, connected: false }),
      enable: () => ok(true),
      disable: () => ok(true),
    },
    commitMessage: {
      generate: () => unavailableData("commitMessage.generate"),
    },
    suggestion: {
      list: () => ok([]),
      accept: () => ok(true),
      dismiss: () => ok(true),
    },
  }
}

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-kilo-directory", "directory"],
    ["x-kilo-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-kilo-directory")
  next.headers.delete("x-kilo-workspace")
  return next
}

export function createKiloClient(
  config?: Config & { directory?: string; experimental_workspaceID?: string },
): KiloClient {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // Pass duplex in the init arg so it survives VS Code's proxy-agent
      // fetch wrapper, which calls originalFetch(request, { ...init, dispatcher })
      // and would otherwise drop duplex from the cloned Request.
      // timeout: false disables Bun's default request timeout for long-running
      // streaming calls (replaces the old req.timeout = false assignment which
      // wouldn't survive the clone triggered by passing an init object).
      return fetch(req, { duplex: "half", timeout: false } as any)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-kilo-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-kilo-workspace": config.experimental_workspaceID,
    }
  }

  // Node.js/Electron require duplex: "half" when creating Request objects
  // with a body. The option propagates through config → opts → requestInit
  // and is harmless in environments that don't need it (Bun, browsers).
  ;(config as any).duplex = "half"

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

    return response
  })
  return Object.assign(new GeneratedKiloClient({ client }), legacyCompat()) as KiloClient
}
