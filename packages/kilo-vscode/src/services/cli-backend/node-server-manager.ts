import { type ChildProcess } from "child_process"
import { spawn } from "../../util/process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { t } from "./i18n"
import { parseServerPort } from "./server-utils"
import { isCloudMode } from "./cloud-mode"
import {
  clearServerState,
  getServerDataDir,
  getServerLogPath,
  pickFreePort,
  probeServer,
  readServerState,
  waitForServer,
  writeServerState,
  type ServerState,
} from "./server-state"
import { type ServerInstance, ServerStartupError, toErrorMessage } from "./server-manager"

const STARTUP_TIMEOUT_SECONDS = 30

// testagent_change start - 企业 ZH relay 默认内网地址（未配置 testagent.zhRelayUrl 时使用）
const DEFAULT_ZH_RELAY_URL = ""
// testagent_change end

/**
 * Server manager for the OpenCode Node.js backend.
 *
 * Instead of spawning a Bun binary, it spawns:
 *   node --experimental-sqlite cli.mjs --port 0 --password <random>
 *
 * The nodejs-server dist is bundled inside the extension at nodejs-server/.
 */
export class NodeServerManager {
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

  async getServer(): Promise<ServerInstance> {
    console.log("[TestAgent] NodeServerManager: 🔍 getServer called")
    if (this.instance) {
      console.log("[TestAgent] NodeServerManager: ♻️ Returning existing instance:", { port: this.instance.port })
      return this.instance
    }

    if (this.startupPromise) {
      console.log("[TestAgent] NodeServerManager: ⏳ Startup already in progress, waiting...")
      return this.startupPromise
    }

    if (isCloudMode()) {
      const adopted = await this.adoptExistingServer()
      if (adopted) {
        this.instance = adopted
        console.log("[TestAgent] NodeServerManager: ✅ Adopted existing cloud server:", { port: adopted.port })
        return adopted
      }
      console.log("[TestAgent] NodeServerManager: ☁️ No live cloud server found, spawning detached daemon")
    }

    console.log("[TestAgent] NodeServerManager: 🚀 Starting new server instance...")
    this.startupPromise = this.startServer()
    try {
      this.instance = await this.startupPromise
      console.log("[TestAgent] NodeServerManager: ✅ Server started successfully:", { port: this.instance.port })
      return this.instance
    } finally {
      this.startupPromise = null
    }
  }

  /**
   * Cloud mode: try to reconnect to an already-running detached daemon.
   */
  private async adoptExistingServer(): Promise<ServerInstance | null> {
    const state = readServerState()
    if (!state) return null

    if (state.version && state.version !== this.context.extension.packageJSON.version) {
      console.warn(
        `[TestAgent] NodeServerManager: ⚠️ Cloud server version mismatch (server=${state.version}, extension=${this.context.extension.packageJSON.version}) — keeping existing daemon to avoid interrupting tasks`,
      )
    }

    const alive = await probeServer(state)
    if (!alive) {
      console.log("[TestAgent] NodeServerManager: ♻️ Server state found but daemon not reachable, will respawn")
      clearServerState()
      return null
    }

    return { port: state.port, password: state.password }
  }

  // testagent_change start - 读取本地模式 ZH relay 地址（设置优先，回退内置默认）
  private resolveZhRelayUrl(): string {
    const configured = vscode.workspace.getConfiguration("testagent").get<string>("zhRelayUrl", "")
    return (configured ?? "").trim() || DEFAULT_ZH_RELAY_URL
  }

  // 设置页「通知」菜单的「招乎回答」开关（testagent.new.notifications.zhAnswer）
  private isZhAnswerEnabled(): boolean {
    return vscode.workspace.getConfiguration("testagent.new.notifications").get<boolean>("zhAnswer", false)
  }
  // testagent_change end

  private handleNotification(message: string) {
    const match = message.match(/\[TESTAGENT_NOTIFICATION\] (.+)/)
    if (!match) return

    try {
      const notification = JSON.parse(match[1])
      if (notification.type !== "plugin-notification") return

      // testagent_change start - 按 action id 分发（保留 enable-auto-compaction）
      const actions: Array<{ id?: string; label: string }> = (
        Array.isArray(notification.actions) ? notification.actions : []
      ).filter(
        (item: unknown): item is { id?: string; label: string } =>
          Boolean(item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string"),
      )
      const labels = actions.map((item) => item.label)
      const show =
        notification.level === "error"
          ? vscode.window.showErrorMessage(`TestAgent: ${notification.message}`, ...labels)
          : vscode.window.showInformationMessage(`TestAgent: ${notification.message}`, ...labels)
      void show.then((selected) => {
        const action = actions.find((item) => item.label === selected)
        if (!action) return
        console.log("[TestAgent] 用户点击了通知按钮", action.id ? { actionID: action.id } : undefined)
        if (action.id === "enable-auto-compaction") {
          this.onEnableAutoCompaction?.()
        }
      })
      // testagent_change end
    } catch (err) {
      console.error("[TestAgent] NodeServerManager: Failed to parse notification:", err)
    }
  }

  // testagent_change start - 回调 serve 切换「招乎回答」开关（设置页通知菜单 + 通知栏 action 共用）
  async setZhAnswerEnabled(enabled: boolean): Promise<void> {
    try {
      const instance = this.instance
      if (!instance) return
      const url = `http://127.0.0.1:${instance.port}`
      const resp = await fetch(`${url}/testagent/zh-answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`opencode:${instance.password}`).toString("base64")}`,
        },
        body: JSON.stringify({ enabled }),
      })
      console.log(`[TestAgent] 招乎回答 ${enabled ? "已开启" : "已关闭"}`, resp.status)
    } catch (err) {
      console.error("[TestAgent] 切换招乎回答失败:", err)
    }
  }
  // testagent_change end

  private async startServer(): Promise<ServerInstance> {
    const password = crypto.randomBytes(32).toString("hex")
    const nodePath = await this.resolveNodePath()
    const serverDir = this.getServerDir()

    console.log("[TestAgent] NodeServerManager: 📍 Node path:", nodePath)
    console.log("[TestAgent] NodeServerManager: 📍 Server dir:", serverDir)

    const entry = path.join(serverDir, "cli.mjs")
    if (!fs.existsSync(entry)) {
      throw new Error(
        `TestAgent server not found at: ${entry}. Please ensure the nodejs-server is bundled with the extension.`,
      )
    }

    const spawnCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? require("os").homedir()

    const cloud = isCloudMode()
    const port = cloud ? await pickFreePort() : 0
    // testagent_change start - 本地模式注入 ZH relay 地址（用户身份/令牌由连接后 PUT /testagent/user 同步）
    const zhRelayUrl = cloud ? "" : this.resolveZhRelayUrl()
    // 设置页「通知」菜单开关决定 serve 启动时插件默认启停
    const zhAnswerEnabled = this.isZhAnswerEnabled()
    // testagent_change end

    return new Promise((resolve, reject) => {
      console.log("[TestAgent] NodeServerManager: 🎬 Spawning Node.js server")

      const args = [
        "--experimental-sqlite",
        entry,
        "--port",
        String(port),
        "--password",
        password,
        "--hostname",
        "127.0.0.1",
      ]

      const commonSpawnOpts = {
        cwd: spawnCwd,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_USERNAME: "opencode",
          LANG: process.env.LANG || "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
          ...(process.platform === "win32" && {
            PYTHONIOENCODING: "utf-8",
          }),
          KILO_CLIENT: "tscode",
          KILOCODE_FEATURE: "tscode-extension",
          KILO_PLATFORM: "tscode",
          KILO_APP_NAME: "testagent",
          KILO_TELEMETRY_LEVEL: vscode.env.isTelemetryEnabled ? "all" : "off",
          KILO_EDITOR_NAME: vscode.env.appName,
          KILO_MACHINE_ID: vscode.env.machineId,
          KILO_APP_VERSION: this.context.extension.packageJSON.version,
          KILO_VSCODE_VERSION: vscode.version,
          KILOCODE_EDITOR_NAME: `${vscode.env.appName} ${vscode.version}`,
          ...(zhRelayUrl && { ZH_RELAY_URL: zhRelayUrl }),
          ...(zhAnswerEnabled && { TESTAGENT_ZH_ANSWER_ENABLED: "1" }),
        },
      }

      if (cloud) {
        return void this.runCloudServer({ entry, nodePath, password, port, spawnCwd, args }, commonSpawnOpts)
          .then(resolve)
          .catch(reject)
      }

      const proc = spawn(nodePath, args, {
        ...commonSpawnOpts,
        stdio: ["ignore", "pipe", "pipe"],
        // Note: detached is removed to prevent console window flash on Windows
        // windowsHide is already set by the spawn() wrapper in util/process.ts
      })

      console.log("[TestAgent] NodeServerManager: 📦 Process spawned with PID:", proc.pid)

      let resolved = false
      const stderrLines: string[] = []

      proc.stdout?.on("data", (data: Buffer) => {
        const output = data.toString()
        console.log("[TestAgent] NodeServerManager: 📥 stdout:", output)

        const port = parseServerPort(output)
        if (port !== null && !resolved) {
          resolved = true
          console.log("[TestAgent] NodeServerManager: 🎯 Port detected:", port)
          resolve({ port, password, process: proc })
        }
      })

      proc.stderr?.on("data", (data: Buffer) => {
        const output = data.toString()
        // Node.js experimental warnings are expected, don't treat as errors
        if (output.includes("ExperimentalWarning")) {
          console.log("[TestAgent] NodeServerManager: ⚡ Node.js warning:", output.trim())
          return
        }
        console.error("[TestAgent] NodeServerManager: ⚠️ stderr:", output)
        stderrLines.push(output)

        // testagent_change start - parse plugin notifications from stderr
        this.handleNotification(output)
        // testagent_change end
      })

      proc.on("error", (error) => {
        console.error("[TestAgent] NodeServerManager: ❌ Process error:", error)
        if (!resolved) {
          reject(error)
        }
      })

      proc.on("exit", (code) => {
        console.log("[TestAgent] NodeServerManager: 🛑 Process exited with code:", code)
        if (this.instance?.process === proc) {
          this.instance = null
        }
        if (!resolved) {
          const { userMessage, userDetails } = toErrorMessage(
            t("server.processExited", { code: code ?? "null" }),
            stderrLines,
            nodePath,
          )
          reject(new ServerStartupError(userMessage, userDetails))
        }
      })

      setTimeout(() => {
        if (!resolved) {
          console.error(`[TestAgent] NodeServerManager: ⏰ Server startup timeout (${STARTUP_TIMEOUT_SECONDS}s)`)
          NodeServerManager.killProcess(proc)
          const { userMessage, userDetails } = toErrorMessage(
            t("server.startupTimeout", { seconds: STARTUP_TIMEOUT_SECONDS }),
            stderrLines,
            nodePath,
          )
          reject(new ServerStartupError(userMessage, userDetails))
        }
      }, STARTUP_TIMEOUT_SECONDS * 1000)
    })
  }

  /**
   * Cloud mode: spawn the Node.js server fully detached (own session, stdio →
   * log file) so it survives the extension host. We wait for it to answer a
   * health probe and persist the connection info to server.json for adoption
   * on the next launch.
   */
  private async runCloudServer(
    input: { entry: string; nodePath: string; password: string; port: number; spawnCwd: string; args: string[] },
    spawnOpts: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<ServerInstance> {
    const { entry, nodePath, password, port, spawnCwd, args } = input

    const logDir = getServerDataDir()
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = getServerLogPath()
    const outFd = fs.openSync(logFile, "a")

    const proc = spawn(nodePath, args, {
      ...spawnOpts,
      cwd: spawnCwd,
      stdio: ["ignore", outFd, outFd],
      detached: true,
    })
    proc.unref()
    console.log("[TestAgent] NodeServerManager: ☁️ Cloud daemon spawned (PID:", proc.pid, "), logging to:", logFile)

    const state: ServerState = {
      port,
      password,
      pid: proc.pid,
      version: this.context.extension.packageJSON.version,
      runtime: "nodejs",
      startedAt: Date.now(),
    }
    const ready = await waitForServer(state, STARTUP_TIMEOUT_SECONDS * 1000)
    if (!ready) {
      clearServerState()
      const { userMessage, userDetails } = toErrorMessage(
        t("server.startupTimeout", { seconds: STARTUP_TIMEOUT_SECONDS }),
        [],
        nodePath,
      )
      throw new ServerStartupError(userMessage, userDetails)
    }
    writeServerState(state)
    console.log("[TestAgent] NodeServerManager: ☁️ Cloud server ready:", { port })
    return { port, password, process: proc }
  }

  /**
   * Find Node.js binary. Priority:
   * 1. TSCode's built-in Node.js (process.execPath)
   * 2. System PATH (which, where)
   * 3. Common installation paths
   *
   * Validates version >= 22.5.0 for node:sqlite support.
   */
  private async resolveNodePath(): Promise<string> {
    const vscodeNode = this.tryVSCodeNode()
    if (vscodeNode) return vscodeNode
    console.warn("[TestAgent] NodeServerManager: ⚠️ Falling back to system node")

    const systemNode = this.trySystemNode()
    if (systemNode) return systemNode
    console.warn("[TestAgent] NodeServerManager: ⚠️ Falling back to common paths")

    const commonNode = this.tryCommonPaths()
    if (commonNode) return commonNode

    throw new Error(
      "Node.js >= 22.5.0 not found.\n\n" +
        "TestAgent backend requires Node.js 22.5+ with node:sqlite support.\n\n" +
        "Options:\n" +
        "1. Install Node.js 22.5+ from https://nodejs.org/ and ensure it's in your PATH\n" +
        "2. Update TSCode to a version that includes Node.js 22.5+ (check Help → About)\n\n" +
        `Current TSCode Node.js: ${process.version}\n` +
        "Required: >= v22.5.0",
    )
  }

  private tryVSCodeNode(): string | null {
    const vscodeNode = process.execPath
    console.log("[TestAgent] NodeServerManager: Checking TSCode built-in Node.js:", vscodeNode)

    // Use running process version (avoids child process unreliability on Windows)
    const nodeVersion = process.versions.node
    if (!nodeVersion) {
      console.warn("[TestAgent] NodeServerManager: No process.versions.node available")
      return null
    }
    console.log("[TestAgent] NodeServerManager: TSCode Node.js version:", `v${nodeVersion}`)

    if (this.isVersionValid(`v${nodeVersion}`)) {
      try {
        const { execSync } = require("child_process")
        // Validate that process.execPath is a real Node.js (not Electron app)
        // that can run standalone. Uses --version which works reliably on Windows,
        // unlike -e with inline code which has quoting issues.
        const raw = execSync(`"${vscodeNode}" --version`, { encoding: "utf8", timeout: 60000, shell: true }).trim()
        if (this.isVersionValid(raw)) {
          console.log("[TestAgent] NodeServerManager: ✅ Using TSCode built-in Node.js")
          return vscodeNode
        }
        console.warn("[TestAgent] NodeServerManager: TSCode built-in Node.js --version output not valid:", raw)
      } catch (err) {
        console.warn("[TestAgent] NodeServerManager: Failed to check TSCode Node.js:", err)
      }
    } else {
      console.warn(`[TestAgent] NodeServerManager: TSCode Node.js v${nodeVersion} too old, need >= 22.5.0`)
    }
    return null
  }

  private trySystemNode(): string | null {
    const { execSync } = require("child_process")
    try {
      if (process.platform === "win32") {
        const found = this.findNodeOnPathWindows()
        if (found) return found
      } else {
        const found = execSync("which node", { encoding: "utf8", timeout: 60000, shell: true }).trim().split("\n")[0]
        if (!found) {
          console.warn("[TestAgent] NodeServerManager: which node returned empty result")
          return null
        }

        const version = execSync(`"${found}" --version`, { encoding: "utf8", timeout: 60000, shell: true }).trim()
        console.log("[TestAgent] NodeServerManager: Found node:", found, version)
        if (this.isVersionValid(version)) return found
        console.warn(`[TestAgent] NodeServerManager: Node.js ${version} too old, need >= 22.5.0`)
      }
    } catch {
      console.warn("[TestAgent] NodeServerManager: Node.js not found in system PATH")
    }
    return null
  }

  private findNodeOnPathWindows(): string | null {
    const { execSync } = require("child_process")
    const pathDirs = (process.env.PATH || "").split(";")
    const seen = new Set<string>()

    for (const dir of pathDirs) {
      const normalized = path.resolve(dir.trim())
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)

      const candidate = path.join(normalized, "node.exe")
      if (!fs.existsSync(candidate)) continue

      try {
        const version = execSync(`"${candidate}" --version`, { encoding: "utf8", timeout: 60000, shell: true }).trim()
        console.log("[TestAgent] NodeServerManager: Found node:", candidate, version)
        if (this.isVersionValid(version)) return candidate
        console.warn(`[TestAgent] NodeServerManager: Node.js ${version} too old, need >= 22.5.0`)
      } catch {}
    }
    return null
  }

  private tryCommonPaths(): string | null {
    const candidates: string[] = []
    if (process.platform === "win32") {
      candidates.push("C:\\Program Files\\nodejs\\node.exe")
      candidates.push(path.join(process.env.LOCALAPPDATA || "", "Programs\\nodejs\\node.exe"))

      const nvmDir = path.join(process.env.USERPROFILE || "", "AppData\\Roaming\\nvm")
      if (fs.existsSync(nvmDir)) {
        try {
          for (const entry of fs.readdirSync(nvmDir)) {
            const nodeExe = path.join(nvmDir, entry, "node.exe")
            if (fs.existsSync(nodeExe)) candidates.push(nodeExe)
          }
        } catch {}
      }
    } else {
      candidates.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node")
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue

      try {
        const { execSync } = require("child_process")
        const version = execSync(`"${candidate}" --version`, { encoding: "utf8", timeout: 60000, shell: true }).trim()
        if (this.isVersionValid(version)) {
          return candidate
        }
      } catch {
        // skip
      }
    }
    return null
  }

  private isVersionValid(version: string): boolean {
    const match = version.match(/^v(\d+)\.(\d+)/)
    if (!match) return false

    const major = parseInt(match[1])
    const minor = parseInt(match[2])
    return major > 22 || (major === 22 && minor >= 5)
  }

  private getServerDir(): string {
    return path.join(this.context.extensionPath, "nodejs-server")
  }

  private static killProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    if (proc.pid === undefined) return
    try {
      proc.kill(signal)
    } catch {
      // Process already gone
    }
  }

  dispose(): void {
    if (!this.instance) {
      return
    }
    const proc = this.instance.process
    this.instance = null

    // Cloud mode: the daemon is intentionally detached from the extension host
    // so tasks keep running after tscode closes. Do NOT kill it.
    if (isCloudMode()) {
      console.log("[TestAgent] NodeServerManager: ☁️ Cloud mode — leaving daemon running (detach), PID:", proc?.pid)
      return
    }

    if (!proc) return

    console.log("[TestAgent] NodeServerManager: 🔴 Disposing — sending SIGTERM, PID:", proc.pid)
    NodeServerManager.killProcess(proc, "SIGTERM")

    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        console.warn("[TestAgent] NodeServerManager: ⚠️ Process did not exit, sending SIGKILL")
        NodeServerManager.killProcess(proc, "SIGKILL")
      }
    }, 5000)
    timer.unref()
    proc.on("exit", () => clearTimeout(timer))
  }
}
