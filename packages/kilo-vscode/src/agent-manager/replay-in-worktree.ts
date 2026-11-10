import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import type { CreateWorktreeResult } from "./WorktreeManager"
import type { WorktreeStateManager } from "./WorktreeStateManager"
import { getErrorMessage } from "../kilo-provider-utils"
import { PLATFORM } from "./constants"
import { plan, type Msg, type Script, type Turn } from "./replay-plan"

export type ReplayArgs = {
  sessionId: string
  messageId: string
  partId: string
  snapshot: string
  directory: string
  mode?: "tools" | "loop"
  span?: "step" | "rest"
}

export type ReplayCtx = {
  getClient: () => KiloClient
  createWorktreeOnDisk: (opts?: { baseBranch?: string }) => Promise<{
    worktree: { id: string }
    result: CreateWorktreeResult
  } | null>
  getStateManager: () => WorktreeStateManager | undefined
  registerWorktreeSession: (sessionId: string, directory: string) => void
  registerSession: (session: Session) => void
  notifyReady: (sessionId: string, result: CreateWorktreeResult, worktreeId: string) => void
  capture: (event: string, props: Record<string, unknown>) => void
  log: (...args: unknown[]) => void
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }
type Progress = (status: string, detail?: string, error?: string) => void

async function restore(ctx: ReplayCtx, args: ReplayArgs, target: string): Promise<Result<void>> {
  const client = clientOf(ctx, "replay materialize")
  if (!client) return { ok: false, error: "Not connected to CLI backend" }
  try {
    await client.session.materialize(
      {
        sessionID: args.sessionId,
        directory: args.directory,
        snapshot: args.snapshot,
        target,
      },
      { throwOnError: true },
    )
    return { ok: true, value: undefined }
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) }
  }
}

async function origin(ctx: ReplayCtx, args: ReplayArgs): Promise<Result<Msg[]>> {
  const client = clientOf(ctx, "replay messages")
  if (!client) return { ok: false, error: "Not connected to CLI backend" }
  try {
    const { data } = await client.session.messages(
      { sessionID: args.sessionId, directory: args.directory },
      { throwOnError: true },
    )
    return { ok: true, value: data as Msg[] }
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) }
  }
}

async function fork(ctx: ReplayCtx, args: ReplayArgs, dir: string, nextId?: string): Promise<Result<Session>> {
  const client = clientOf(ctx, "replay fork")
  if (!client) return { ok: false, error: "Not connected to CLI backend" }
  try {
    const { data } = await client.session.fork(
      {
        sessionID: args.sessionId,
        directory: dir,
        messageID: nextId,
      },
      { throwOnError: true },
    )
    return { ok: true, value: data }
  } catch (err) {
    const text = getErrorMessage(err)
    ctx.log("Replay fork failed:", text, err)
    return { ok: false, error: `Failed to fork session: ${text}` }
  }
}

async function copied(ctx: ReplayCtx, sessionId: string, dir: string): Promise<Result<Msg[]>> {
  const client = clientOf(ctx, "replay forked messages")
  if (!client) return { ok: false, error: "Not connected to CLI backend" }
  try {
    const { data } = await client.session.messages({ sessionID: sessionId, directory: dir }, { throwOnError: true })
    return { ok: true, value: data as Msg[] }
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) }
  }
}

function mapped(
  source: Msg[],
  dest: Msg[],
  messageId: string,
  partId: string,
): Result<{ messageID: string; partID: string }> {
  const idx = source.findIndex((item) => item.info.id === messageId)
  if (idx < 0) return { ok: false, error: "Replay message not found" }
  const partIdx = source[idx].parts.findIndex((part) => part.id === partId)
  if (partIdx < 0) return { ok: false, error: "Replay step not found" }
  const clone = dest[idx]
  if (!clone) return { ok: false, error: "Forked message not found" }
  const part = clone.parts[partIdx]
  if (!part) return { ok: false, error: "Forked step not found" }
  return { ok: true, value: { messageID: clone.info.id, partID: part.id } }
}

async function play(
  ctx: ReplayCtx,
  sessionId: string,
  dir: string,
  messageID: string,
  partID: string,
  extra?: { mode: "loop"; script: Script; scripts: Script[]; turns: Turn[] },
): Promise<Result<void>> {
  const client = clientOf(ctx, "replay step")
  if (!client) return { ok: false, error: "Not connected to CLI backend" }
  try {
    await client.session.replay(
      extra
        ? {
            sessionID: sessionId,
            directory: dir,
            messageID,
            partID,
            mode: extra.mode,
            script: extra.script,
            scripts: extra.scripts,
            turns: extra.turns.length ? extra.turns : undefined,
          }
        : { sessionID: sessionId, directory: dir, messageID, partID },
      { throwOnError: true },
    )
    return { ok: true, value: undefined }
  } catch (err) {
    return { ok: false, error: `Failed to replay step: ${getErrorMessage(err)}` }
  }
}

function clientOf(ctx: ReplayCtx, label: string): KiloClient | undefined {
  try {
    return ctx.getClient()
  } catch (err) {
    ctx.log(`Client not available for ${label}:`, getErrorMessage(err))
    return undefined
  }
}

function register(
  ctx: ReplayCtx,
  session: Session,
  result: CreateWorktreeResult,
  worktreeId: string,
  sourceId: string,
): void {
  const state = ctx.getStateManager()
  if (state) state.addSession(session.id, worktreeId)
  ctx.registerWorktreeSession(session.id, result.path)
  ctx.notifyReady(session.id, result, worktreeId)
  ctx.registerSession(session)
  ctx.capture("Replay in Worktree", { source: PLATFORM, sessionId: session.id, worktreeId })
  ctx.log(`Replayed sidebar session ${sourceId} → worktree ${worktreeId} (session ${session.id})`)
}

/**
 * Replay a sidebar model step in a new worktree.
 * Restores the step snapshot, copies history through the clicked node,
 * then either re-runs recorded tools or feeds recorded output through the agent loop.
 */
export async function replayInWorktree(ctx: ReplayCtx, args: ReplayArgs, progress: Progress): Promise<void> {
  if (!args.snapshot) return progress("error", undefined, "该步骤没有文件快照，无法回放")
  if (!args.partId) return progress("error", undefined, "缺少步骤 ID，无法回放")

  progress("creating", "Creating worktree...")
  const created = await ctx.createWorktreeOnDisk({})
  if (!created) return progress("error", undefined, "Failed to create worktree")

  progress("restoring", "Restoring snapshot...")
  const restored = await restore(ctx, args, created.result.path)
  if (!restored.ok) return progress("error", undefined, restored.error)

  const source = await origin(ctx, args)
  if (!source.ok) return progress("error", undefined, source.error)
  const idx = source.value.findIndex((item) => item.info.id === args.messageId)
  if (idx < 0) return progress("error", undefined, "Replay message not found")
  const next = source.value[idx + 1]
  const cutoff = args.mode === "loop" ? args.messageId : next?.info.id

  progress("forking", "Starting session...")
  const forked = await fork(ctx, args, created.result.path, cutoff)
  if (!forked.ok) return progress("error", undefined, forked.error)

  if (args.mode === "loop") {
    const span = args.span === "rest" ? "rest" : "step"
    const built = plan(source.value, args.messageId, args.partId, span)
    if (!built.ok) return progress("error", undefined, built.error)
    ctx.log(
      `Loop replay ${span}: ${built.value.scripts.length} step(s), ${built.value.turns.length} later turn(s)`,
    )
    register(ctx, forked.value, created.result, created.worktree.id, args.sessionId)
    progress("replaying", span === "rest" ? "Replaying session..." : "Replaying step...")
    const replayed = await play(ctx, forked.value.id, created.result.path, args.messageId, args.partId, {
      mode: "loop",
      script: built.value.scripts[0],
      scripts: built.value.scripts,
      turns: built.value.turns,
    })
    if (!replayed.ok) return progress("error", undefined, replayed.error)
    progress("done")
    return
  }

  const dest = await copied(ctx, forked.value.id, created.result.path)
  if (!dest.ok) return progress("error", undefined, dest.error)
  const ids = mapped(source.value, dest.value, args.messageId, args.partId)
  if (!ids.ok) return progress("error", undefined, ids.error)

  register(ctx, forked.value, created.result, created.worktree.id, args.sessionId)

  progress("replaying", "Replaying step...")
  const replayed = await play(ctx, forked.value.id, created.result.path, ids.value.messageID, ids.value.partID)
  if (!replayed.ok) return progress("error", undefined, replayed.error)

  progress("done")
}
