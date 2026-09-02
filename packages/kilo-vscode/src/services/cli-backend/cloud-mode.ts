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
