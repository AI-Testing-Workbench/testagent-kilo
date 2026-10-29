// testagent_change - new file
import { describe, it, expect } from "bun:test"

const { KiloProvider } = await import("../../src/KiloProvider")

type Internals = {
  connectionState: "connected"
  gitStateReady: boolean
  cachedGitRepo: boolean
  projectID: string | undefined
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  startStatsPolling: () => void
}

describe("KiloProvider Git repository refresh", () => {
  it("invalidates the cached project and reloads sessions when Git opens in the workspace", async () => {
    const calls: string[] = []
    const sent: unknown[] = []
    const client = {
      instance: {
        dispose: async (input: { directory: string }) => {
          calls.push(`dispose:${input.directory}`)
        },
      },
      session: {
        list: async (input: { directory: string }) => {
          calls.push(`list:${input.directory}`)
          return {
            data: [
              {
                id: "ses_git",
                projectID: "project-git",
                title: "Git session",
                directory: input.directory,
                time: { created: 1, updated: 2 },
              },
            ],
          }
        },
      },
    }
    const provider = new KiloProvider({} as never, { getClient: () => client } as never)
    const state = provider as unknown as Internals
    state.connectionState = "connected"
    state.gitStateReady = true
    state.cachedGitRepo = false
    state.projectID = "global"
    state.webview = { postMessage: async (message) => sent.push(message) }
    state.startStatsPolling = () => calls.push("start-stats")

    await KiloProvider.refreshGitRepository("/elsewhere")
    expect(calls).toEqual([])

    await Promise.all([KiloProvider.refreshGitRepository("/repo"), KiloProvider.refreshGitRepository("/repo")])
    KiloProvider.instances.delete(provider)

    expect(calls).toEqual(["dispose:/repo", "start-stats", "list:/repo"])
    expect(state.projectID).toBe("project-git")
    expect(state.cachedGitRepo).toBe(true)
    expect(sent).toContainEqual({ type: "gitStatus", repo: true })
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "sessionsLoaded",
        sessions: [expect.objectContaining({ id: "ses_git" })],
      }),
    )
  })
})
