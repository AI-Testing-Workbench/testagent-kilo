import { type ChildProcess } from "child_process"
import { spawn } from "../../util/process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { t } from "./i18n"
import { parseServerPort } from "./server-utils"

export interface ServerInstance {
  port: number
  password: string
  process: ChildProcess
}

const STARTUP_TIMEOUT_SECONDS = 30

export class ServerManager {
  private instance: ServerInstance | null = null
  private startupPromise: Promise<ServerInstance> | null = null
  private logLevel: string | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onEnableAutoCompaction?: () => void,
  ) {}

  setLogLevel(level: string | undefined) {
    this.logLevel = level
  }

  /**
   * Get or start the server instance
   */
  async getServer(): Promise<ServerInstance> {
    console.log("[TestAgent] ServerManager: 🔍 getServer called")
    if (this.instance) {
      console.log("[TestAgent] ServerManager: ♻️ Returning existing instance:", { port: this.instance.port })
      return this.instance
    }

    if (this.startupPromise) {
      console.log("[TestAgent] ServerManager: ⏳ Startup already in progress, waiting...")
      return this.startupPromise
    }

    console.log("[TestAgent] ServerManager: 🚀 Starting new server instance...")
    this.startupPromise = this.startServer()
    try {
      this.instance = await this.startupPromise
      console.log("[TestAgent] ServerManager: ✅ Server started successfully:", { port: this.instance.port })
      return this.instance
    } finally {
      this.startupPromise = null
    }
  }

  private handleNotification(message: string) {
    const match = message.match(/\[TESTAGENT_NOTIFICATION\] (.+)/)
    if (!match) return

    try {
      const notification = JSON.parse(match[1])
      if (notification.type !== "plugin-notification") return

      const actions = Array.isArray(notification.actions) ? notification.actions : []
      const list = actions
        .map((item: unknown) => {
          if (!item || typeof item !== "object" || !("label" in item)) return undefined
          return typeof item.label === "string" ? item : undefined
        })
        .filter((item: unknown): item is { id?: string; label: string } => Boolean(item))
      const action = list[0]
      const label = action?.label
      const show =
        notification.level === "error"
          ? vscode.window.showErrorMessage(`TestAgent: ${notification.message}`, ...list.map((item) => item.label))
          : vscode.window.showInformationMessage(
              `TestAgent: ${notification.message}`,
              ...list.map((item) => item.label),
            )
      void show.then((selected) => {
        if (!action || selected !== label) return
        console.log("[TestAgent] 用户点击了确定", action.id ? { actionID: action.id } : undefined)
        this.onEnableAutoCompaction?.()
      })
    } catch (err) {
      console.error("[TestAgent] ServerManager: Failed to parse notification:", err)
    }
  }

  private async startServer(): Promise<ServerInstance> {
    const password = crypto.randomBytes(32).toString("hex")
    const cliPath = this.getCliPath()
    console.log("[TestAgent] ServerManager: 📍 CLI path:", cliPath)
    console.log("[TestAgent] ServerManager: 🔐 Generated password (length):", password.length)

    if (!fs.existsSync(cliPath)) {
      throw new Error(
        `CLI binary not found at expected path: ${cliPath}. Please ensure the CLI is built and bundled with the extension.`,
      )
    }

    const stat = fs.statSync(cliPath)
    console.log("[TestAgent] ServerManager: 📄 CLI isFile:", stat.isFile())
    console.log("[TestAgent] ServerManager: 📄 CLI mode (octal):", (stat.mode & 0o777).toString(8))

    const meta = await this.getUserMeta()
    const claudeCompat = vscode.workspace.getConfiguration("testagent.new").get<boolean>("claudeCodeCompat", false)
    const spawnCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? require("os").homedir()
    const args = ["serve", "--port", "0"]
    if (this.logLevel) args.push("--log-level", this.logLevel)

    return this.runServer({ cliPath, password, spawnCwd, args, claudeCompat, meta })
  }

  private async getUserMeta() {
    try {
      const session = await vscode.authentication.getSession("tscode-oauth", [], { createIfNone: false })
      const meta = (session as any).metadata
      return {
        userId: session?.account.id,
        userName: session?.account.label,
        sapId: meta?.sapId,
        openId: meta?.openId,
        originPathId: meta?.originPathId,
        pathName: meta?.pathName,
      }
    } catch {
      return undefined
    }
  }

  private runServer(input: {
    cliPath: string
    password: string
    spawnCwd: string
    args: string[]
    claudeCompat: boolean
    meta:
      | {
          userId?: string
          userName?: string
          sapId?: string
          openId?: string
          originPathId?: string
          pathName?: string
        }
      | undefined
  }): Promise<ServerInstance> {
    console.log("[TestAagent New] ServerManager: 🎬 Spawning CLI process:", input.cliPath, input.args)
    console.log("[TestAgent] ServerManager: 🌐 Extension host LANG:", process.env.LANG)
    console.log("[TestAgent] ServerManager: 🌐 Extension host LC_ALL:", process.env.LC_ALL)
    console.log("[TestAgent] ServerManager: 🌐 Will set LANG to:", process.env.LANG || "en_US.UTF-8")
    console.log("[TestAgent] ServerManager: 🌐 Platform:", process.platform)

    const serverProcess = spawn(input.cliPath, input.args, {
      cwd: input.spawnCwd,
      env: {
        ...process.env,
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
        ...(process.platform === "win32" && {
          PYTHONIOENCODING: "utf-8",
        }),
        OPENCODE_SERVER_PASSWORD: input.password,
        OPENCODE_SERVER_USERNAME: "opencode",
        MIMALLOC_PURGE_DELAY: "0",
        KILO_CLIENT: "vscode",
        KILO_ENABLE_QUESTION_TOOL: "true",
        KILOCODE_FEATURE: "vscode-extension",
        KILO_TELEMETRY_LEVEL: vscode.env.isTelemetryEnabled ? "all" : "off",
        KILO_APP_NAME: "testagent",
        KILO_EDITOR_NAME: vscode.env.appName,
        KILO_PLATFORM: "vscode",
        KILO_MACHINE_ID: vscode.env.machineId,
        KILO_APP_VERSION: this.context.extension.packageJSON.version,
        KILO_VSCODE_VERSION: vscode.version,
        KILOCODE_EDITOR_NAME: `${vscode.env.appName} ${vscode.version}`,
        ...(!input.claudeCompat && { KILO_DISABLE_CLAUDE_CODE: "true" }),
        ...(input.meta?.userId && { TESTAGENT_USER_ID: input.meta.userId }),
        ...(input.meta?.userName && { TESTAGENT_USER_NAME: input.meta.userName }),
        ...(input.meta?.sapId && { TESTAGENT_SAP_ID: input.meta.sapId }),
        ...(input.meta?.openId && { TESTAGENT_OPEN_ID: input.meta.openId }),
        ...(input.meta?.originPathId && { TESTAGENT_ORIGIN_PATH_ID: input.meta.originPathId }),
        ...(input.meta?.pathName && { TESTAGENT_PATH_NAME: input.meta.pathName }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform !== "win32" && { detached: true }),
    })
    console.log("[TestAgent] ServerManager: 📦 Process spawned with PID:", serverProcess.pid)

    const stderrLines: string[] = []
    let resolved = false

    return new Promise((resolve, reject) => {
      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString()
        console.log("[TestAgent] ServerManager: 📥 CLI Server stdout:", output)

        const port = parseServerPort(output)
        if (port === null || resolved) return

        resolved = true
        console.log("[TestAgent] ServerManager: 🎯 Port detected:", port)
        resolve({ port, password: input.password, process: serverProcess })
      })

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const errorOutput = data.toString()
        console.error("[TestAgent] ServerManager: ⚠️ CLI Server stderr:", errorOutput)
        stderrLines.push(errorOutput)
        this.handleNotification(errorOutput)
      })

      serverProcess.on("error", (error) => {
        console.error("[TestAgent] ServerManager: ❌ Process error:", error)
        if (!resolved) reject(error)
      })

      serverProcess.on("exit", (code) => {
        console.log("[TestAgent] ServerManager: 🛑 Process exited with code:", code)
        if (this.instance?.process === serverProcess) {
          this.instance = null
        }
        if (resolved) return
        const { userMessage, userDetails } = toErrorMessage(
          t("server.processExited", { code: code ?? "null" }),
          stderrLines,
          input.cliPath,
        )
        reject(new ServerStartupError(userMessage, userDetails))
      })

      setTimeout(() => {
        if (resolved) return
        console.error(`[TestAgent] ServerManager: ⏰ Server startup timeout (${STARTUP_TIMEOUT_SECONDS}s)`)
        ServerManager.killProcess(serverProcess)
        const { userMessage, userDetails } = toErrorMessage(
          t("server.startupTimeout", { seconds: STARTUP_TIMEOUT_SECONDS }),
          stderrLines,
          input.cliPath,
        )
        reject(new ServerStartupError(userMessage, userDetails))
      }, STARTUP_TIMEOUT_SECONDS * 1000)
    })
  }

  private getCliPath(): string {
    // Always use the bundled binary from the extension directory
    const binName = process.platform === "win32" ? "testagent.exe" : "testagent"
    const cliPath = path.join(this.context.extensionPath, "bin", binName)
    console.log("[TestAgent] ServerManager: 📦 Using CLI path:", cliPath)
    return cliPath
  }

  /**
   * Kill a process and its entire process group.
   * On Unix, we send the signal to -pid (negative) to reach the whole group,
   * mirroring the desktop app's ProcessGroup::leader() + start_kill() pattern.
   * On Windows, process.kill() on the child handle is sufficient.
   */
  private static killProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    if (proc.pid === undefined) {
      return
    }
    try {
      if (process.platform !== "win32") {
        // Negative PID targets the entire process group
        process.kill(-proc.pid, signal)
      } else {
        proc.kill(signal)
      }
    } catch {
      // Process already gone — ignore
    }
  }

  dispose(): void {
    if (!this.instance) {
      return
    }
    const proc = this.instance.process
    this.instance = null

    console.log("[TestAgent] ServerManager: 🔴 Disposing — sending SIGTERM to process group, PID:", proc.pid)
    ServerManager.killProcess(proc, "SIGTERM")

    // SIGKILL fallback after 5s: mirrors the desktop app going straight to
    // start_kill(). Ensures the process tree dies even if SIGTERM is ignored
    // or Instance.disposeAll() hangs past the serve.ts shutdown timeout.
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        console.warn("[TestAgent] ServerManager: ⚠️ Process did not exit after SIGTERM, sending SIGKILL")
        ServerManager.killProcess(proc, "SIGKILL")
      }
    }, 5000)
    // unref so this timer doesn't prevent the extension host from exiting
    timer.unref()
    proc.on("exit", () => clearTimeout(timer))
  }
}

export class ServerStartupError extends Error {
  readonly userMessage: string
  readonly userDetails: string
  constructor(userMessage: string, userDetails: string) {
    super(userDetails)
    this.name = "ServerStartupError"
    this.userMessage = userMessage
    this.userDetails = userDetails
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

export function toErrorMessage(
  error: string,
  stderrLines: string[],
  cliPath?: string,
): {
  userMessage: string
  userDetails: string
  error: string
} {
  let lines = stderrLines.flatMap((line) => line.split("\n"))

  const errorLine = lines.map(stripAnsi).find((line) => /Error:\s+/.test(line))
  const userMessage = errorLine
    ? errorLine.match(/Error:\s+(.+)/)![1].trim()
    : stripAnsi([...lines].reverse().find((line) => line.trim() !== "") ?? error).trim()

  lines = [error, ...lines]
  if (cliPath && cliPath.trim() !== "") {
    lines = [`CLI path: ${cliPath}`, ...lines]
  }

  const detailsText = lines.map(stripAnsi).join("\n").trim()

  return {
    userMessage,
    userDetails: detailsText,
    error,
  }
}
