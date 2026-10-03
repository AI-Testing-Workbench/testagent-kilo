import * as os from "os"

/**
 * Resolve the host that others can use to reach the web UI.
 *
 * In a k8s cloud container the pod IP is exposed, so we prefer an explicit
 * override (`TESTAGENT_SHARE_HOST`) and otherwise fall back to the first
 * non-internal IPv4 address of this machine.
 */
function resolveShareHost(): string {
  const override = process.env.TESTAGENT_SHARE_HOST
  if (override) return override

  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address
    }
  }
  return "127.0.0.1"
}

export function formatWebUiLink(input: {
  port: number
  password: string
  username?: string
  host?: string
  path?: string
}): string {
  const token = Buffer.from(`${input.username ?? "opencode"}:${input.password}`).toString("base64")
  const host = input.host ?? resolveShareHost()
  return `http://${host}:${input.port}${input.path ?? "/"}?auth_token=${encodeURIComponent(token)}`
}

/**
 * Deep link to a session inside the web UI. `directory` is encoded the same way
 * the app encodes the `:dir` route param (base64url without padding).
 */
export function sessionPath(directory: string, sessionID: string): string {
  return `/${Buffer.from(directory, "utf8").toString("base64url")}/session/${sessionID}`
}
