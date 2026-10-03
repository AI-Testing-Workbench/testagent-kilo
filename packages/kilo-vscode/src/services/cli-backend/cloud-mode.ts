import { existsSync } from "fs"

/**
 * Detect whether the extension host is running in a tscode cloud sandbox.
 *
 * Two signals, set by the sandbox image entrypoint (start-sshd.sh):
 * 1. `TESTAGENT_CLOUD_MODE=1` in the SSH session environment (via /etc/environment)
 * 2. Marker file `/etc/tscode-cloud-mode` (fallback when env propagation fails)
 *
 * In cloud mode the CLI/Node.js server is spawned as a detached daemon so it
 * keeps running tasks after the local tscode window closes, and the extension
 * adopts (reconnects to) the already-running daemon on the next launch.
 */
export function isCloudMode(): boolean {
  return process.env.TESTAGENT_CLOUD_MODE === "1" || existsSync("/etc/tscode-cloud-mode")
}

/**
 * Whether the backend server should run as a shared, detached daemon that is
 * discovered/adopted via `server.json` (instead of a private child of the
 * extension host).
 *
 * Cloud mode always does. Local tscode windows can opt in via
 * `TESTAGENT_SHARED_SERVER=1`, so the editor extension and the Agent Host
 * (Agents window) share a single backend process instead of each spawning its
 * own — switching between the editor and the Agents window then never restarts
 * the backend.
 */
export function shouldShareServer(): boolean {
  return isCloudMode() || process.env.TESTAGENT_SHARED_SERVER === "1"
}
 * Fixed port for the cloud server so the container can expose it through a
 * stable k8s Service/Ingress target port. Cloud sandboxes are isolated, so the
 * port is free for the detached daemon.
 */
export const CLOUD_SERVER_PORT = 4096

/**
 * Bind the cloud server on all interfaces so the pod IP is reachable from
 * outside the container. Loopback-only binds are not reachable via k8s.
 */
export const CLOUD_SERVER_HOSTNAME = "0.0.0.0"
