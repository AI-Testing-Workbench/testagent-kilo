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
 * Following the on-desk split (plugin = translator, app = state machine), this
 * bridge owns the small "waiting for the user" state machine: it watches the
 * raw `permission.asked` / `question.asked` (and their replies) directly — the
 * same events the sidebar already consumes — and suppresses the plugin's
 * `working` updates while a request is outstanding, so the notification pose is
 * held until the user answers.
 *
 * The command travels the normal extension-command route, so it reaches the
 * local desktop window even across a remote/SSH bridge. When the extension runs
 * in a plain VS Code (no TSCode) the command does not exist and the call is
 * ignored.
 */

const PET_STATE_EVENT = "testagent.pet.state"
const SET_STATE_COMMAND = "desktopPet.setState"

interface PetEvent {
  type?: string
  properties?: { state?: unknown; sessionID?: unknown }
}

/** Normalizes a session id emitted by the plugin (`testagent:<raw>`) to `<raw>`. */
function stripId(id: unknown): string | undefined {
  if (typeof id !== "string" || !id) return undefined
  return id.startsWith("testagent:") ? id.slice("testagent:".length) : id
}

function send(state: string): void {
  // Fire-and-forget: reject when the command is not registered (plain VS Code).
  void vscode.commands.executeCommand(SET_STATE_COMMAND, state).then(undefined, () => { /* no TSCode desktop pet */ })
}

/**
 * The editor-mode state machine. Returns without emitting when a raw state must
 * be suppressed (busy updates while the user is being prompted).
 */
function onEvent(event: PetEvent, waiting: Set<string>): void {
  const type = event.type
  if (!type) return
  const sid = stripId(event.properties?.sessionID)

  switch (type) {
    // Waiting for the user → hold notification (authoritative for the pet).
    case "permission.asked":
    case "question.asked":
      if (sid) waiting.add(sid)
      send("notification")
      return
    // The user answered → resume working.
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
      if (sid) waiting.delete(sid)
      send("working")
      return
    case PET_STATE_EVENT: {
      const state = event.properties?.state
      if (typeof state !== "string") return
      // While waiting, ignore the plugin's busy updates so notification sticks.
      if (state === "working" && sid && waiting.has(sid)) return
      if ((state === "complete" || state === "idle") && sid) waiting.delete(sid)
      send(state)
      return
    }
    default:
      return
  }
}

export function registerDesktopPetBridge(connectionService: KiloConnectionService): vscode.Disposable {
  const waiting = new Set<string>()
  const unsubscribe = connectionService.onEvent((event) => onEvent(event as PetEvent, waiting))
  return { dispose: unsubscribe }
}
