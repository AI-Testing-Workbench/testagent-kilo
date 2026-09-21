import * as vscode from "vscode"
import * as path from "path"
import type { Event, KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../cli-backend"
import { McpHttpServer, type McpToolResult, type McpToolSpec } from "./mcp-server"

type State = "disabled" | "registering" | "connected" | "failed" | "disconnected"

/**
 * Browser tools that VS Code registers into `vscode.lm.tools` and that we forward to the agent.
 *
 * VS Code does not tag these tools (`tags` comes back empty), so selecting them by name is the
 * only reliable option. Names that are absent from `vscode.lm.tools` are skipped, which keeps
 * this working on builds that expose fewer of them.
 */
const BROWSER_TOOLS = [
  "open_browser_page",
  "read_page",
  "screenshot_page",
  "navigate_page",
  "click_element",
  "type_in_page",
  "hover_element",
  "drag_element",
  "handle_dialog",
  "run_playwright_code",
  "list_browser_pages",
]

/** Setting that gates VS Code's own browser tools; they are absent from `vscode.lm.tools` when off. */
const CHAT_TOOLS_SETTING = "workbench.browser.enableChatTools"

/**
 * How long to wait for VS Code to publish its browser tools into `vscode.lm.tools`.
 *
 * The list is only populated a few seconds after activation, and whatever we report the first
 * time the CLI asks for tools is what it caches for the rest of the session. Registering before
 * the tools exist would silently produce an empty tool list.
 */
const TOOL_WAIT_MS = 30_000

/** How often to re-check the published tool set while enabled, so a late change still lands. */
const WATCH_INTERVAL_MS = 5_000

/** Only prompt the user once per session: the tools cannot appear until the window reloads. */
let nudged = false

/**
 * Bridges VS Code's built-in browser tools into the agent.
 *
 * The agent runs in a separate CLI process with no access to the `vscode` module, so the tools
 * cannot be called directly. Instead this service runs a small localhost MCP server inside the
 * extension host and registers it with the CLI as a remote MCP server: the CLI calls the MCP
 * server, and the MCP server calls `vscode.lm.invokeTool` on the CLI's behalf.
 */
export class VscodeBrowserToolsService implements vscode.Disposable {
  private static readonly MCP_SERVER_NAME = "testagent-tscode"
  private static readonly SERVER_VERSION = "1.0.0"

  private state: State = "disabled"
  private disposables: vscode.Disposable[] = []
  private server: McpHttpServer | undefined
  private watcher: ReturnType<typeof setInterval> | undefined
  private attempted: string | undefined
  private registered = false
  /** Serializes `ensure()`: reload and disposal can arrive together and each drops the bridge. */
  private busy = false
  private queued = false

  constructor(private readonly connectionService: KiloConnectionService) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        // The Playwright setting is watched too: enabling it must release these tools, and
        // disabling it must give them back.
        if (
          e.affectsConfiguration("testagent.new.vscodeBrowserTools") ||
          e.affectsConfiguration("testagent.new.browserAutomation")
        ) {
          void this.syncWithSettings()
        }
      }),
      // This bridge is registered at runtime, so the CLI only knows about it in memory. Every
      // path that rebuilds CLI state starts from the config file, which never lists it:
      // `/mcp/reload` wipes the MCP state outright, and a global or instance disposal tears the
      // whole instance down. Without these hooks the agent silently loses every VS Code browser
      // tool until the backend restarts.
      vscode.Disposable.from(
        { dispose: connectionService.onMcpReloaded(() => void this.ensure()) },
        { dispose: connectionService.onEvent((event) => this.onBackendEvent(event)) },
      ),
    )
  }

  /** Re-register after the CLI throws away backend state, which takes the bridge down with it. */
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
   * two concurrent `register()` calls would fight over the same MCP server entry. A trigger that
   * arrives while one is in flight queues a single extra pass rather than starting a second.
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

  /** Read settings and enable/disable accordingly. Called on construction and on settings change. */
  async syncWithSettings(): Promise<void> {
    if (this.enabled()) return this.ensure()
    await this.unregister()
  }

  /** Re-register after the CLI backend reconnects. Called from the connection state handler. */
  async reregisterIfEnabled(): Promise<void> {
    await this.ensure()
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.stopWatch()
    void this.stopServer()
  }

  private async register(): Promise<void> {
    this.setState("registering")

    // The CLI backend starts lazily, so it is normally missing on activation. Staying quiet here
    // is fine because the connection state handler calls `reregisterIfEnabled()` once it is up.
    const client = this.getClient()
    if (!client) {
      this.setState("disconnected")
      return
    }

    const tools = await this.waitForTools()
    this.attempted = fingerprint(tools)
    this.reportTools(tools)
    this.startWatch()

    // Nothing to expose yet: watch in case VS Code publishes the tools later, but leave no empty
    // MCP server behind, since that would only add a dead entry to the agent's tool list.
    if (tools.length === 0) {
      this.setState("disabled")
      return
    }

    try {
      const url = await this.startServer()
      const directory = this.getWorkspaceDirectory()
      const { data: status } = await client.mcp.add(
        {
          name: VscodeBrowserToolsService.MCP_SERVER_NAME,
          config: {
            type: "remote",
            url,
            enabled: true,
            // Localhost needs no OAuth; leaving it enabled would make the CLI probe for metadata.
            oauth: false,
            // Seconds. Tool calls such as `open_browser_page` can take tens of seconds on a cold start.
            timeout: 120,
          },
          directory,
        },
        { throwOnError: true },
      )

      const serverStatus = status[VscodeBrowserToolsService.MCP_SERVER_NAME]
      if (serverStatus?.status === "connected") {
        this.registered = true
        this.setState("connected")
        return
      }
      if (serverStatus?.status === "failed") {
        console.error(
          "[TestAgent] VscodeBrowserToolsService: MCP server failed:",
          (serverStatus as { error?: string }).error,
        )
        this.setState("failed")
        return
      }
      this.setState("disconnected")
    } catch (error) {
      console.error("[TestAgent] VscodeBrowserToolsService: Failed to register MCP server:", error)
      await this.stopServer()
      this.setState("failed")
    }
  }

  private async unregister(): Promise<void> {
    this.stopWatch()
    this.attempted = undefined

    if (this.registered) {
      this.registered = false
      const client = this.getClient()
      if (client) {
        try {
          await client.mcp.disconnect(
            { name: VscodeBrowserToolsService.MCP_SERVER_NAME, directory: this.getWorkspaceDirectory() },
            { throwOnError: true },
          )
        } catch (error) {
          console.error("[TestAgent] VscodeBrowserToolsService: Failed to disconnect MCP server:", error)
        }
      }
    }

    await this.stopServer()
    this.setState("disabled")
  }

  private async startServer(): Promise<string> {
    const running = this.server?.url
    if (running) return running

    const server = new McpHttpServer(
      {
        list: () => this.listTools(),
        call: (name, args, signal) => this.callTool(name, args, signal),
      },
      { name: VscodeBrowserToolsService.MCP_SERVER_NAME, version: VscodeBrowserToolsService.SERVER_VERSION },
    )
    const url = await server.start()
    this.server = server
    return url
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    await server.stop()
  }

  /**
   * Built fresh on every call: `vscode.lm.tools` only fills in a few seconds after activation
   * and offers no change event, so a cached copy would risk staying empty for the session.
   */
  private listTools(): McpToolSpec[] {
    return vscode.lm.tools
      .filter((tool) => BROWSER_TOOLS.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
      }))
  }

  /**
   * Wait until `vscode.lm.tools` holds a stable, non-empty set of browser tools.
   *
   * Returns whatever is available once the deadline passes, so a build without browser tools
   * still registers (and reports an empty list) rather than waiting forever.
   */
  private async waitForTools(): Promise<McpToolSpec[]> {
    const deadline = Date.now() + TOOL_WAIT_MS
    let last: string | undefined
    for (;;) {
      const tools = this.listTools()
      const key = fingerprint(tools)
      // Two matching readings in a row. VS Code publishes the set in one batch, but waiting for a
      // repeat is cheaper to reason about than relying on that.
      if (key && key === last) return tools
      last = key
      if (Date.now() >= deadline) return tools
      await delay(500)
    }
  }

  /** The CLI caches the tool list for the life of a connection, so a later change needs a re-add. */
  private startWatch(): void {
    this.stopWatch()
    this.watcher = setInterval(() => {
      if (fingerprint(this.listTools()) === this.attempted) return
      console.log("[TestAgent] VscodeBrowserToolsService: Browser tools changed, re-registering")
      // Through `ensure()` rather than `register()` so this cannot race a reload/dispose pass.
      void this.ensure()
    }, WATCH_INTERVAL_MS)
  }

  private stopWatch(): void {
    if (!this.watcher) return
    clearInterval(this.watcher)
    this.watcher = undefined
  }

  /** Log what VS Code actually published, so a missing tool list can be told apart from a bad link. */
  private reportTools(tools: McpToolSpec[]): void {
    const names = tools.map((tool) => tool.name)
    console.log(
      `[TestAgent] VscodeBrowserToolsService: vscode.lm.tools has ${vscode.lm.tools.length} entries, ` +
        `${names.length} of them are browser tools${names.length > 0 ? `: ${names.join(", ")}` : ""}`,
    )
    if (names.length > 0) return

    // The setting exists in every VS Code version this extension supports, so a missing tool list
    // means the user (or a policy) turned it off rather than that the build cannot provide it.
    const enabled = this.chatToolsEnabled()
    console.warn(
      `[TestAgent] VscodeBrowserToolsService: VS Code exposes no browser tools ` +
        `("${CHAT_TOOLS_SETTING}" is ${enabled ? "on" : "off"}); the agent gets none.`,
    )
    if (enabled || nudged) return
    nudged = true
    void vscode.window
      .showWarningMessage(
        `TestAgent: VS Code is not exposing its browser tools, so the agent got none. ` +
          `Turn on "${CHAT_TOOLS_SETTING}" and reload the window.`,
        "Open Setting",
      )
      .then((choice) => {
        if (choice !== "Open Setting") return
        return vscode.commands.executeCommand("workbench.action.openSettings", `@id:${CHAT_TOOLS_SETTING}`)
      })
  }

  private async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult> {
    if (!BROWSER_TOOLS.includes(name)) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
    }

    const source = new vscode.CancellationTokenSource()
    const cancel = () => source.cancel()
    signal.addEventListener("abort", cancel, { once: true })
    try {
      const result = await vscode.lm.invokeTool(name, { input: args, toolInvocationToken: undefined }, source.token)
      return { content: toContent(result.content) }
    } finally {
      signal.removeEventListener("abort", cancel)
      source.dispose()
    }
  }

  private chatToolsEnabled(): boolean {
    return vscode.workspace.getConfiguration("workbench.browser").get<boolean>("enableChatTools", false)
  }

  private enabled(): boolean {
    if (!vscode.workspace.getConfiguration("testagent.new.vscodeBrowserTools").get<boolean>("enabled", true)) {
      return false
    }
    // The two browser backends are mutually exclusive. The settings panel writes the other one off,
    // but a hand-edited settings.json could still hold both as true. Playwright wins that tie: it is
    // the explicit opt-in of the two, while these tools are on by default.
    return !vscode.workspace.getConfiguration("testagent.new.browserAutomation").get<boolean>("enabled", false)
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
    if (folders && folders.length > 0) return folders[0].uri.fsPath
    return process.cwd()
  }

  private setState(state: State): void {
    if (this.state === state) return
    console.log(`[TestAgent] VscodeBrowserToolsService: State ${this.state} → ${state}`)
    this.state = state
  }
}

/**
 * Flatten a VS Code tool result into MCP content blocks.
 *
 * Image parts are summarised rather than forwarded: an MCP image block would be inlined as
 * base64 into the tool output, and that round trip is not known to survive the agent side.
 */
function toContent(parts: readonly unknown[]): Array<Record<string, unknown>> {
  const content = parts.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return { type: "text", text: part.value }
    if (part instanceof vscode.LanguageModelDataPart) {
      return { type: "text", text: `[${part.mimeType} data omitted, ${part.data.byteLength} bytes]` }
    }
    return { type: "text", text: describe(part) }
  })
  return content.length > 0 ? content : [{ type: "text", text: "(no output)" }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Cheap fingerprint of a tool list, used to tell whether the published set changed. */
function fingerprint(tools: McpToolSpec[]): string {
  return tools
    .map((tool) => tool.name)
    .sort()
    .join(",")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
