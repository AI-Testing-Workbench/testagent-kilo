import type { ReplayArgs } from "../agent-manager/replay-in-worktree"

type Progress = (status: string, detail?: string, error?: string) => void

type Ctx = {
  args?: ReplayArgs
  handler?: (args: ReplayArgs, progress: Progress) => Promise<void>
  post: (message: { type: "continueInWorktreeProgress"; status: string; detail?: string; error?: string }) => void
}

export function handleReplaySession(ctx: Ctx): void {
  if (ctx.args && ctx.handler) {
    ctx
      .handler(ctx.args, (status, detail, error) => {
        ctx.post({ type: "continueInWorktreeProgress", status, detail, error })
      })
      .catch((err: unknown) => {
        console.error("[TestAgent New] replaySession failed:", err)
        ctx.post({
          type: "continueInWorktreeProgress",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return
  }

  ctx.post({
    type: "continueInWorktreeProgress",
    status: "error",
    error: "Replay is not available",
  })
}
