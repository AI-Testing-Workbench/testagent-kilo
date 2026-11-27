import { describe, expect, it } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type ProviderInternals = {
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  currentSession: unknown
  getSdtRunner: (sid: string) => { run: (opts: unknown) => void }
  handleSendCommand: (
    command: string,
    args: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
  ) => Promise<void>
  handleSendMessage: (
    text: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
  ) => Promise<void>
}

type SessionCreatedMessage = { type: string; draftID?: string; session?: { id: string } }

/**
 * The tab strip only shows a session's real title once the placeholder
 * "new session" tab has been swapped for the backend session id. That swap is
 * driven by the draftID carried on the sessionCreated message — without it the
 * tab stays a placeholder and keeps rendering "新会话" no matter what title
 * the backend ends up with.
 */
const DRAFT_ID = "sidebar-pending:tab-1"

function createProvider() {
  const sent: unknown[] = []
  const runs: unknown[] = []

  const service = {
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:1234", password: "pw" }),
    getClient: () => ({
      session: {
        create: async () => ({
          data: {
            id: "ses_1",
            parentID: undefined,
            title: "New session - 2026-11-23T09:00:00.000Z",
            time: { created: 1, updated: 1 },
          },
        }),
      },
    }),
  }

  const provider = new KiloProvider({} as never, service as never)
  const internals = provider as unknown as ProviderInternals

  internals.webview = {
    postMessage: async (message: unknown) => {
      sent.push(message)
    },
  }
  internals.getSdtRunner = () => ({
    run: (opts: unknown) => {
      runs.push(opts)
    },
  })

  return { provider, internals, sent, runs }
}

function sessionCreated(sent: unknown[]): SessionCreatedMessage | undefined {
  return sent.find((message) => (message as SessionCreatedMessage).type === "sessionCreated") as
    | SessionCreatedMessage
    | undefined
}

describe("KiloProvider SDT session tab", () => {
  it("carries the draft id into the session created message for /sdt-* commands", async () => {
    const { internals, sent, runs } = createProvider()

    await internals.handleSendCommand("sdt-run", "my-stage", "msg_1", undefined, DRAFT_ID)

    const created = sessionCreated(sent)
    expect(created).toBeDefined()
    expect(created!.draftID).toBe(DRAFT_ID)
    expect(created!.session?.id).toBe("ses_1")
    expect(runs).toHaveLength(1)
  })

  it("carries the draft id into the session created message for /sdt-* text", async () => {
    const { internals, sent, runs } = createProvider()

    await internals.handleSendMessage("/sdt-run my-stage", "msg_1", undefined, DRAFT_ID)

    const created = sessionCreated(sent)
    expect(created).toBeDefined()
    expect(created!.draftID).toBe(DRAFT_ID)
    expect(created!.session?.id).toBe("ses_1")
    expect(runs).toHaveLength(1)
  })

  it("still omits the draft id when the caller has none", async () => {
    const { internals, sent } = createProvider()

    await internals.handleSendCommand("sdt-run", "my-stage", "msg_1", undefined, undefined)

    const created = sessionCreated(sent)
    expect(created).toBeDefined()
    expect(created!.draftID).toBeUndefined()
  })
})
