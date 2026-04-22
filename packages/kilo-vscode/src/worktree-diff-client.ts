import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { GitOps } from "./agent-manager/GitOps"
import { diffFile as localDiffFile } from "./agent-manager/local-diff" // testagent_change

/**
 * A worktree diff target: the working directory and the base branch we diff
 * against (usually the tracking branch).
 */
export type DiffTarget = { directory: string; baseBranch: string }

type Status = "added" | "deleted" | "modified"

/**
 * Thin coordinator that wraps (KiloClient, GitOps, DiffTarget) and exposes the
 * small set of operations used by both the sidebar DiffViewerProvider and the
 * agent manager's WorktreeDiffController.
 *
 * Keeping the helper off review-utils.ts: this deals in HTTP + git orchestration,
 * not the small path/vscode helpers that file is scoped to.
 */
export class WorktreeDiffClient {
  constructor(
    private readonly client: KiloClient,
    private readonly git: GitOps,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  /**
   * Look up the diff status for a single file. Used by revert flows to pick
   * the right git strategy (added → delete, modified/deleted → checkout).
   * Returns `undefined` on error so callers can still attempt a best-effort
   * revert — `GitOps.revertFile` defaults to a modified-file strategy.
   * 
   * testagent_change start - use local-diff instead of HTTP to avoid timeout
   */
  async fileStatus(target: DiffTarget, file: string): Promise<Status | undefined> {
    try {
      const result = await localDiffFile(this.git, target.directory, target.baseBranch, file, (...args) => this.log(...args))
      return result?.status
    } catch (err) {
      this.log("Failed to look up file status for revert:", err)
      return undefined
    }
  }
  // testagent_change end

  /**
   * Revert a single file in the worktree. Composes `fileStatus` + `GitOps.revertFile`.
   * Returns a normalized result; callers handle UI/messaging.
   */
  async revertFile(target: DiffTarget, file: string): Promise<{ ok: boolean; message: string }> {
    const status = await this.fileStatus(target, file)
    return this.git.revertFile(target.directory, target.baseBranch, file, status)
  }
}
