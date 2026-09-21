import * as vscode from "vscode"
import * as path from "path"
import type { Event, KiloClient, McpStatus } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../cli-backend"

export type BrowserAutomationState = "disabled" | "registering" | "connected" | "failed" | "disconnected"

export class BrowserAutomationService implements vscode.Disposable {
  private state: BrowserAutomationState = "disabled"
  private disposables: vscode.Disposable[] = []
  private stateListeners: Array<(state: BrowserAutomationState) => void> = []
  /** Serializes `ensure()`: reload and disposal can arrive together and each drops the server. */
  private busy = false
  private queued = false

  // MCP server name used when registering with the CLI backend
  private static readonly MCP_SERVER_NAME = "testagent-playwright"

  constructor(private readonly connectionService: KiloConnectionService) {
    // Listen for settings changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("testagent.new.browserAutomation")) {
          this.syncWithSettings()
        }
      }),
      // This server is registered at runtime, so the CLI only knows about it in memory. Every
      // path that rebuilds CLI state starts from the config file, which never lists it:
      // `/mcp/reload` wipes the MCP state outright, and a global or instance disposal tears the
      // whole instance down. Without these hooks the agent silently loses the Playwright tools
      // until the backend restarts.
      vscode.Disposable.from(
        { dispose: connectionService.onMcpReloaded(() => void this.ensure()) },
        { dispose: connectionService.onEvent((event) => this.onBackendEvent(event)) },
      ),
    )
  }

  /** Re-register after the CLI throws away backend state, which takes the server down with it. */
  private onBackendEvent(event: Event): void {
    if (event.type === "global.disposed") {
      void this.ensure()
      return
    }
    if (event.type !== "server.instance.disposed") return
    const props = event.properties as Record<string, unknown> | null
    const dir = typeof props?.directory === "string" ? props.directory : undefined
    // Another workspace folder has its own instance, and its own registration on top of this one.
    if (dir && path.resolve(dir) !== path.resolve(this.getWorkspaceDirectory())) return
    void this.ensure()
  }

  /**
   * Re-register if enabled, at most one registration at a time.
   *
   * The triggers overlap by design (a reload is usually followed by an instance disposal), and
   * two concurrent `register()` calls would fight over the same MCP server entry - and each one
   * spawns its own `npx @playwright/mcp` process. A trigger that arrives while one is in flight
   * queues a single extra pass rather than starting a second.
   */
  private async ensure(): Promise<void> {
    if (this.busy) {
      this.queued = true
      return
    }
    this.busy = true
    try {
      do {
        this.queued = false
        if (!this.enabled()) return
        await this.register()
      } while (this.queued)
    } finally {
      this.busy = false
    }
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("testagent.new.browserAutomation").get<boolean>("enabled", false)
  }

  /** Current state */
  getState(): BrowserAutomationState {
    return this.state
  }

  /** Subscribe to state changes */
  onStateChange(listener: (state: BrowserAutomationState) => void): () => void {
    this.stateListeners.push(listener)
    return () => {
      const idx = this.stateListeners.indexOf(listener)
      if (idx >= 0) {
        this.stateListeners.splice(idx, 1)
      }
    }
  }

  /**
   * Read settings and enable/disable accordingly.
   * Called on construction and when settings change.
   */
  async syncWithSettings(): Promise<void> {
    if (this.enabled()) return this.ensure()
    await this.unregister()
  }

  /**
   * Re-register the MCP server after CLI backend reconnects.
   * Should be called from the connection state change handler.
   */
  async reregisterIfEnabled(): Promise<void> {
    await this.ensure()
  }

  /**
   * Register the Playwright MCP server with the CLI backend.
   */
  private async register(): Promise<void> {
    this.setState("registering")

    const client = this.getClient()
    if (!client) {
      console.error("[TestAgent] BrowserAutomationService: No SDK client available")
      this.setState("failed")
      return
    }

    const config = vscode.workspace.getConfiguration("testagent.new.browserAutomation")
    const useSystemChrome = config.get<boolean>("useSystemChrome", true)
    const headless = config.get<boolean>("headless", false)

    // Build the command for the Playwright MCP server
    const command = ["npx", "@playwright/mcp@latest"]
    if (headless) {
      command.push("--headless")
    }
    if (useSystemChrome) {
      command.push("--browser", "chrome")
    }

    try {
      const directory = this.getWorkspaceDirectory()
      const { data: status } = await client.mcp.add(
        {
          name: BrowserAutomationService.MCP_SERVER_NAME,
          config: {
            type: "local",
            command,
            enabled: true,
            timeout: 60000,
          },
          directory,
        },
        { throwOnError: true },
      )

      const serverStatus = status[BrowserAutomationService.MCP_SERVER_NAME]
      if (serverStatus?.status === "connected") {
        this.setState("connected")
      } else if (serverStatus?.status === "failed") {
        console.error(
          "[TestAgent] BrowserAutomationService: MCP server failed:",
          (serverStatus as { error?: string }).error,
        )
        this.setState("failed")
      } else {
        this.setState("disconnected")
      }
    } catch (error) {
      console.error("[TestAgent] BrowserAutomationService: Failed to register MCP server:", error)
      this.setState("failed")
    }
  }

  /**
   * Unregister/disconnect the Playwright MCP server.
   */
  private async unregister(): Promise<void> {
    if (this.state === "disabled") {
      return
    }

    const client = this.getClient()
    if (client) {
      try {
        const directory = this.getWorkspaceDirectory()
        await client.mcp.disconnect(
          { name: BrowserAutomationService.MCP_SERVER_NAME, directory },
          { throwOnError: true },
        )
      } catch (error) {
        console.error("[TestAgent] BrowserAutomationService: Failed to disconnect MCP server:", error)
      }
    }

    this.setState("disabled")
  }

  /**
   * Get the current MCP server status from the CLI backend.
   */
  async getServerStatus(): Promise<McpStatus | null> {
    const client = this.getClient()
    if (!client) {
      return null
    }

    try {
      const directory = this.getWorkspaceDirectory()
      const { data: allStatus } = await client.mcp.status({ directory }, { throwOnError: true })
      return allStatus[BrowserAutomationService.MCP_SERVER_NAME] ?? null
    } catch {
      return null
    }
  }

  private getClient(): KiloClient | null {
    try {
      return this.connectionService.getClient()
    } catch {
      return null
    }
  }

  private getWorkspaceDirectory(): string {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath
    }
    return process.cwd()
  }

  private setState(state: BrowserAutomationState): void {
    if (this.state === state) {
      return
    }
    console.log(`[TestAgent] BrowserAutomationService: State ${this.state} → ${state}`)
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
    this.stateListeners = []
  }
}
