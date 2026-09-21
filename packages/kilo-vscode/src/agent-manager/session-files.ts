// testagent_change - new file
import * as path from "path"
import type { KiloClient } from "@kilocode/sdk/v2/client"

/** Tools that write files. Their part metadata carries the paths they touched. */
const WRITERS = new Set(["edit", "write", "apply_patch", "multiedit"])

function norm(value: string): string {
  return value.replaceAll("\\", "/")
}

function pick(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * Extract the file paths a tool part wrote to.
 *
 * Deliberately lenient: the result is only ever used to *filter* a git diff, so
 * an extra path is harmless (a file that was merely read does not appear in that
 * diff) while a missing one would silently hide a real change. Paths are
 * returned as-is, absolute ones included — `SessionFiles.get` translates them.
 */
export function editedFiles(part: unknown): string[] {
  // SSE tool parts name the tool `tool`, the REST `session.messages` body uses `name`.
  const name = pick(part, "tool") ?? pick(part, "name")
  if (pick(part, "type") !== "tool" || typeof name !== "string" || !WRITERS.has(name)) return []
  const state = pick(part, "state")
  const input = pick(state, "input")
  const meta = pick(state, "metadata")
  const found: string[] = []
  const push = (value: unknown) => {
    if (typeof value === "string" && value) found.push(norm(value))
  }
  const pushAll = (value: unknown, key: string) => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (typeof item === "string") push(item)
      else push(pick(item, key))
    }
  }
  for (const key of ["filePath", "filepath", "file_path", "path"]) push(pick(input, key))
  pushAll(pick(input, "files"), "filePath")
  pushAll(pick(input, "paths"), "filePath")
  push(pick(meta, "filepath"))
  push(pick(meta, "filePath"))
  pushAll(pick(meta, "files"), "file")
  return [...new Set(found)]
}

/**
 * Tracks which files each session has actually modified, so the changes panel
 * can be scoped to one session instead of the whole worktree.
 *
 * The set is seeded from the server's snapshot diff (`session.diff` event /
 * `GET /session/:id/diff`), which covers exactly what the agent touched — but it
 * is only written once a turn *finishes*, so live tool parts are merged in as
 * they stream. Without that, a just-created session would look empty and fall
 * back to the unscoped worktree diff, which reads as "the scope toggle does
 * nothing".
 */
export class SessionFiles {
  private readonly cache = new Map<string, Set<string>>()
  /** Sessions we have already loaded from the server at least once. */
  private readonly loaded = new Set<string>()

  constructor(private readonly log: (msg: string) => void) {}

  /** Merge file paths into a session's set. Empty input is a no-op. */
  add(sessionId: string, files: string[]): void {
    if (!sessionId || !files.length) return
    const entry = this.cache.get(sessionId) ?? new Set<string>()
    for (const file of files) entry.add(norm(file))
    this.cache.set(sessionId, entry)
  }

  /**
   * File set for a session.
   *
   * `undefined` means "we could not find out" — the caller then falls back to the
   * unscoped worktree diff rather than showing a blank panel. An *empty* set
   * means "we asked and this session has not touched anything", which has to
   * render as no changes. Conflating the two is what made a brand new session
   * show every change in the repository.
   *
   * `directory` re-keys absolute tool paths into repo-relative ones so they can
   * be matched against diff entries.
   */
  async get(client: KiloClient, sessionId: string, directory?: string): Promise<Set<string> | undefined> {
    if (!sessionId) return undefined
    if (!this.loaded.has(sessionId) && !(await this.load(client, sessionId, directory))) return undefined
    const entry = this.cache.get(sessionId)
    if (!entry) return new Set()
    if (!directory) return entry
    return this.resolve(entry, directory)
  }

  /** Translate absolute paths into repo-relative ones so diffs can be matched. */
  private resolve(entry: Set<string>, directory: string): Set<string> {
    const out = new Set<string>()
    for (const file of entry) {
      out.add(file)
      if (path.isAbsolute(file)) out.add(norm(path.relative(directory, file)))
    }
    return out
  }

  /** Load a session's change set from the server. False if every read failed. */
  private async load(client: KiloClient, sessionId: string, directory?: string): Promise<boolean> {
    let ok = false
    try {
      const result = await client.session.diff({ sessionID: sessionId })
      if (!result.error && Array.isArray(result.data)) {
        ok = true
        this.add(
          sessionId,
          result.data.map((item) => item.file),
        )
      }
    } catch (error) {
      this.log(`Failed to read session diff for ${sessionId}: ${describe(error)}`)
    }
    // A snapshot diff already tells us what the session touched. Only when there
    // is none — a turn still in flight — is it worth mining the tool parts.
    if (!this.cache.has(sessionId)) ok = (await this.loadParts(client, sessionId, directory)) || ok
    // Live tool parts may already have given us a usable set even if both reads failed.
    const known = ok || this.cache.has(sessionId)
    if (known) this.loaded.add(sessionId)
    return known
  }

  /** Reconstruct the file set from the tool parts of a session's messages. */
  private async loadParts(client: KiloClient, sessionId: string, directory?: string): Promise<boolean> {
    try {
      const query = directory ? { sessionID: sessionId, directory } : { sessionID: sessionId }
      const result = await client.session.messages(query)
      if (result.error || !Array.isArray(result.data)) return false
      for (const message of result.data) {
        for (const part of (message as { parts?: unknown[] }).parts ?? []) this.add(sessionId, editedFiles(part))
      }
      return true
    } catch (error) {
      this.log(`Failed to read session messages for ${sessionId}: ${describe(error)}`)
      return false
    }
  }

  clear(): void {
    this.cache.clear()
    this.loaded.clear()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
