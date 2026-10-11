// testagent_change - new file
import * as vscode from "vscode"
import type { KiloConnectionService } from "../cli-backend"

/**
 * Forwards TestAgent pet-state events to the TSCode desktop pet.
 *
 * The built-in `testagent-pet` plugin (packages/testagent-core) normalizes
 * session events into pet states and broadcasts them on the server's global
 * event stream as `testagent.pet.state`. In **editor plugin mode** there is no
 * Agent Host in this window, so the desktop pet (which lives in the TSCode
 * desktop app) cannot observe Agent Host actions; this bridge relays the state
 * through a TSCode core command instead.
 *
 * The command travels the normal extension-command route, so it reaches the
 * local desktop window even across a remote/SSH bridge. When the extension runs
 * in a plain VS Code (no TSCode) the command does not exist and the call is
 * ignored.
 */
export function registerDesktopPetBridge(connectionService: KiloConnectionService): vscode.Disposable {
  const PET_STATE_EVENT = "testagent.pet.state"
  const SET_STATE_COMMAND = "desktopPet.setState"

  const unsubscribe = connectionService.onEvent((event) => {
    const payload = event as { type?: string; properties?: { state?: unknown } } | undefined
    if (!payload || payload.type !== PET_STATE_EVENT) {
      return
    }
    const state = payload.properties?.state
    if (typeof state !== "string") {
      return
    }
    // Fire-and-forget: reject when the command is not registered (plain VS Code).
    void vscode.commands.executeCommand(SET_STATE_COMMAND, state).then(undefined, () => { /* no TSCode desktop pet */ })
  })

  return { dispose: unsubscribe }
}
