import { createServer } from "net"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Persistent server state for cloud mode.
 *
 * The server daemon runs detached from the extension host; on the next launch
 * the extension reads this file and reconnects (adopts) the running daemon
 * instead of spawning a new one. Stored in the same data dir as the SQLite
 * database so it is naturally scoped to the container/user.
 */

export interface ServerState {
  port: number
  password: string
  pid?: number
  version?: string
  runtime?: string
  startedAt?: number
}

export function getServerDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(xdgData, "testagent")
}

export function getServerStatePath(): string {
  return path.join(getServerDataDir(), "server.json")
}

export function readServerState(): ServerState | null {
  try {
    const filePath = getServerStatePath()
    if (!fs.existsSync(filePath)) return null
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ServerState
    if (!parsed || typeof parsed.port !== "number" || typeof parsed.password !== "string") return null
    return parsed
  } catch (err) {
    console.error("[TestAgent] Failed to read server state:", err)
    return null
  }
}

export function writeServerState(state: ServerState): void {
  try {
    const dir = getServerDataDir()
    fs.mkdirSync(dir, { recursive: true })
    const filePath = getServerStatePath()
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.chmodSync(filePath, 0o600)
  } catch (err) {
    console.error("[TestAgent] Failed to write server state:", err)
  }
}

export function clearServerState(): void {
  try {
    fs.unlinkSync(getServerStatePath())
  } catch {
    // nothing to clear
  }
}

export function getServerLogPath(): string {
  return path.join(getServerDataDir(), "server.log")
}

/**
 * Probe whether a server daemon is alive and answering requests.
 */
export async function probeServer(state: ServerState, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/global/health`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}` },
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait until the server daemon answers a health probe, or timeout.
 */
export async function waitForServer(
  state: ServerState,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeServer(state)) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/**
 * Pick a free TCP port on 127.0.0.1, starting from `preferred`.
 * The tiny close-and-rebind race is acceptable in a per-user container.
 */
export function pickFreePort(preferred = 4096, maxAttempts = 100): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, attempt: number) => {
      const server = createServer()
      server.once("error", () => {
        try {
          server.close()
        } catch {
          // ignore
        }
        if (attempt >= maxAttempts) reject(new Error("No free port found for cloud server"))
        else tryListen(port + 1, attempt + 1)
      })
      server.listen(port, "127.0.0.1", () => {
        const address = server.address()
        const actualPort = typeof address === "object" && address ? address.port : port
        server.close(() => resolve(actualPort))
      })
    }
    tryListen(preferred, 0)
  })
}
