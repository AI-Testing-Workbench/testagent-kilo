import * as vscode from "vscode"
import type { KiloConnectionService } from "./services/cli-backend"
import { buildWebviewHtml } from "./utils"
import { GitOps } from "./agent-manager/GitOps"
import { diffFile as localDiffFile, diffSummary as localDiffSummary } from "./agent-manager/local-diff"
import { editedFiles, SessionFiles } from "./agent-manager/session-files"
import type { WorktreeDiffEntry } from "./agent-manager/types"
import type { DiffScope } from "./agent-manager/worktree-diff-controller"
import { WorktreeDiffClient, type DiffTarget } from "./worktree-diff-client"
import {
  appendOutput,
  getWorkspaceRoot,
  hashFileDiffs,
  openWorkspaceRelativeFile,
  resolveLocalDiffTarget,
} from "./review-utils"

/**
 * DiffViewerProvider opens a full-screen diff viewer in an editor tab.
 * It shows the local workspace diff and forwards review comments back to the sidebar chat.
 */
export class DiffViewerProvider implements vscode.Disposable {
  public static readonly viewType = "testagent.new.DiffViewerPanel"

  private panel: vscode.WebviewPanel | undefined
  private diffInterval: ReturnType<typeof setInterval> | undefined
  private lastDiffHash: string | undefined
  private cachedDiffTarget: DiffTarget | undefined
  private gitOps: GitOps
  private outputChannel: vscode.OutputChannel
  private onSendComments: ((comments: unknown[], autoSend: boolean) => void) | undefined
  // testagent_change start - session-scoped review
  /** Session this panel was opened for. `undefined` → only the whole worktree can be shown. */
  private sessionId: string | undefined
  /** Which changes the viewer shows. `openPanel` picks `session` whenever a session is known. */
  private diffScope: DiffScope = "worktree"
  private sessionFiles: SessionFiles
  private sessionFilesUnsub: (() => void) | undefined
  /** Files whose contents are already being fetched, so repeated expand clicks spawn one git call. */
  private pending = new Set<string>()
  // testagent_change end

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionService: KiloConnectionService,
  ) {
    this.gitOps = new GitOps({ log: (...args) => this.log(...args) })
    this.outputChannel = vscode.window.createOutputChannel("TestAgent Diff Viewer")
    // testagent_change start - keep the session's touched-file set fresh while an agent runs
    this.sessionFiles = new SessionFiles((msg) => this.log(msg))
    this.sessionFilesUnsub = connectionService.onEvent((event) => {
      // Live tool parts make a session's change set visible as soon as the agent
      // writes a file, long before the server's snapshot diff is written.
      if (event.type === "message.part.updated") {
        const part = event.properties.part as { sessionID?: string }
        if (part.sessionID) this.sessionFiles.add(part.sessionID, editedFiles(event.properties.part))
        return
      }
      if (event.type !== "session.diff") return
      this.sessionFiles.add(
        event.properties.sessionID,
        event.properties.diff.map((item) => item.file),
      )
    })
    // testagent_change end
  }

  private log(...args: unknown[]) {
    appendOutput(this.outputChannel, "DiffViewer", ...args)
  }

  public setCommentHandler(handler: (comments: unknown[], autoSend: boolean) => void): void {
    this.onSendComments = handler
  }

  public openPanel(sessionId?: string): void {
    // testagent_change start - default to the session that opened the panel
    const changed = this.sessionId !== sessionId
    this.sessionId = sessionId
    if (changed) this.diffScope = sessionId ? "session" : "worktree"
    // testagent_change end

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One)
      // testagent_change start - the panel may have been reopened for another session
      this.postState()
      if (changed) {
        this.lastDiffHash = undefined
        void this.pollDiff()
      }
      // testagent_change end
      return
    }

    const panel = vscode.window.createWebviewPanel(DiffViewerProvider.viewType, "Changes", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    })

    this.wirePanel(panel)
  }

  /** Re-wire a deserialized panel after extension restart. */
  public deserializePanel(panel: vscode.WebviewPanel): void {
    this.wirePanel(panel)
  }

  private wirePanel(panel: vscode.WebviewPanel): void {
    this.panel = panel

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-light.png"),
      dark: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-dark.png"),
    }

    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), undefined, [])
    panel.webview.html = this.getHtml(panel.webview)

    panel.onDidDispose(() => {
      this.log("Panel disposed")
      this.stopDiffPolling()
      this.panel = undefined
    })
  }

  /**
   * Commands sent by the standalone diff panel. Returns `true` once handled so
   * `onMessage` can stop looking.
   */
  private handleViewCommand(msg: Record<string, unknown>): boolean {
    const type = msg.type as string

    if (type === "diffViewer.sendComments" && Array.isArray(msg.comments)) {
      this.onSendComments?.(msg.comments, !!msg.autoSend)
      return true
    }

    if (type === "diffViewer.close") {
      this.panel?.dispose()
      return true
    }

    if (type === "diffViewer.setDiffStyle") return true

    // testagent_change start - switch between session-scoped and whole-worktree changes
    if (type === "diffViewer.setDiffScope" && (msg.scope === "session" || msg.scope === "worktree")) {
      if (this.diffScope === msg.scope) return true
      this.diffScope = msg.scope
      this.lastDiffHash = undefined
      void this.pollDiff()
      return true
    }
    // testagent_change end

    if (typeof msg.file !== "string") return false

    // testagent_change start - contents arrive on demand as files are expanded
    if (type === "diffViewer.requestDiff") {
      void this.requestFile(msg.file)
      return true
    }
    // testagent_change end

    if (type === "diffViewer.revertFile") {
      void this.revertFile(msg.file)
      return true
    }

    return false
  }

  private onMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string

    if (type === "webviewReady") {
      this.post({
        type: "ready",
        serverInfo: this.connectionService.getServerInfo(), // testagent_change - add serverInfo
        vscodeLanguage: vscode.env.language,
        languageOverride: vscode.workspace.getConfiguration("testagent.new").get<string>("language"),
        workspaceDirectory: getWorkspaceRoot(),
      })
      this.postState() // testagent_change - report session + scope
      this.startDiffPolling()
      return
    }

    if (this.handleViewCommand(msg)) return

    if (type === "openFile" && typeof msg.filePath === "string") {
      openWorkspaceRelativeFile(msg.filePath, typeof msg.line === "number" ? msg.line : undefined)
    }
  }

  private async revertFile(file: string): Promise<void> {
    const target = this.cachedDiffTarget ?? (await this.resolveLocalDiffTarget())
    if (!target) {
      this.post({
        type: "diffViewer.revertFileResult",
        file,
        status: "error",
        message: "Could not resolve diff target",
      })
      return
    }

    try {
      const diff = new WorktreeDiffClient(this.connectionService.getClient(), this.gitOps, (...args) =>
        this.log(...args),
      )
      const result = await diff.revertFile(target, file)
      this.post({
        type: "diffViewer.revertFileResult",
        file,
        status: result.ok ? "success" : "error",
        message: result.message,
      })
      if (result.ok) void this.pollDiff()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log("Failed to revert file:", message)
      this.post({ type: "diffViewer.revertFileResult", file, status: "error", message })
    }
  }

  private async resolveLocalDiffTarget(): Promise<DiffTarget | undefined> {
    return await resolveLocalDiffTarget(this.gitOps, (...args) => this.log(...args), getWorkspaceRoot())
  }

  /**
   * Refresh the file list for the active scope.
   *
   * Read in-process through `GitOps.execGit()` rather than the HTTP
   * `worktree.diff` route: that route answers with `Snapshot.FileDiff`, which
   * carries no `before`/`after`, so the panel had no contents to render.
   */
  private async loadDiffs(target: DiffTarget): Promise<WorktreeDiffEntry[]> {
    const diffs = await localDiffSummary(this.gitOps, target.directory, target.baseBranch, (...args) =>
      this.log(...args),
    )
    return await this.scoped(diffs, target.directory)
  }

  private async initialFetch(): Promise<void> {
    this.post({ type: "diffViewer.loading", loading: true })

    const target = await this.resolveLocalDiffTarget()
    if (!target) {
      this.post({ type: "diffViewer.diffs", diffs: [] })
      this.post({ type: "diffViewer.loading", loading: false })
      return
    }

    this.cachedDiffTarget = target

    try {
      // Session scoping reads the session's touched files back through the client.
      await this.connectionService.connect(target.directory)
      const shown = await this.loadDiffs(target)
      this.lastDiffHash = hashFileDiffs(shown)
      this.log(`Initial diff: ${shown.length} file(s)`)
      this.post({ type: "diffViewer.diffs", diffs: shown })
    } catch (err) {
      this.log("Failed to fetch initial diff:", err)
      this.post({ type: "diffViewer.diffs", diffs: [] })
    } finally {
      this.post({ type: "diffViewer.loading", loading: false })
    }
  }

  /**
   * Resolve one file's contents. The list only carries metadata, so the panel
   * asks for a file's `before`/`after` when the user expands it.
   */
  private async requestFile(file: string): Promise<void> {
    if (this.pending.has(file)) return
    this.pending.add(file)

    try {
      const target = this.cachedDiffTarget ?? (await this.resolveLocalDiffTarget())
      if (!target) {
        this.post({ type: "diffViewer.diffFile", file, diff: null })
        return
      }

      this.cachedDiffTarget = target
      const diff = await localDiffFile(this.gitOps, target.directory, target.baseBranch, file, (...args) =>
        this.log(...args),
      )
      this.post({ type: "diffViewer.diffFile", file, diff })
    } catch (err) {
      this.log("Failed to fetch file diff:", err)
      this.post({ type: "diffViewer.diffFile", file, diff: null })
    } finally {
      this.pending.delete(file)
    }
  }

  private async pollDiff(): Promise<void> {
    const target = this.cachedDiffTarget
    if (!target) {
      await this.initialFetch()
      return
    }

    try {
      const diffs = await this.loadDiffs(target)
      const hash = hashFileDiffs(diffs)

      if (hash === this.lastDiffHash) return
      this.lastDiffHash = hash
      this.post({ type: "diffViewer.diffs", diffs })
    } catch (err) {
      this.log("Failed to poll diff:", err)
    }
  }

  private startDiffPolling(): void {
    this.stopDiffPolling()
    this.lastDiffHash = undefined
    this.cachedDiffTarget = undefined

    void this.initialFetch().then(() => {
      if (!this.panel) return
      this.diffInterval = setInterval(() => {
        void this.pollDiff()
      }, 2500)
    })
  }

  private stopDiffPolling(): void {
    if (this.diffInterval) {
      clearInterval(this.diffInterval)
      this.diffInterval = undefined
    }

    this.lastDiffHash = undefined
    this.cachedDiffTarget = undefined
  }

  private post(message: Record<string, unknown>): void {
    if (this.panel?.webview) void this.panel.webview.postMessage(message)
  }

  // testagent_change start - session-scoped review helpers
  private postState(): void {
    this.post({ type: "diffViewer.state", sessionId: this.sessionId, diffScope: this.diffScope })
  }

  /**
   * Narrow the worktree diff down to the files the session actually touched.
   *
   * Only an *unknown* session change set falls back to the full worktree diff so
   * the panel never goes blank; a session that is known to have touched nothing
   * correctly shows no changes.
   */
  private async scoped<T extends { file: string }>(diffs: T[], directory: string): Promise<T[]> {
    if (this.diffScope !== "session" || !this.sessionId) return diffs
    const files = await this.sessionFiles.get(this.connectionService.getClient(), this.sessionId, directory)
    if (!files) return diffs
    return diffs.filter((diff) => files.has(diff.file))
  }
  // testagent_change end

  private getHtml(webview: vscode.Webview): string {
    return buildWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "diff-viewer.js")),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "diff-viewer.css")),
      iconsBaseUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "icons")),
      title: "Changes",
      port: this.connectionService.getServerInfo()?.port,
      extraStyles: "#root { display: flex; flex-direction: column; }",
    })
  }

  public dispose(): void {
    this.stopDiffPolling()
    // testagent_change start
    this.sessionFilesUnsub?.()
    this.sessionFiles.clear()
    this.pending.clear()
    // testagent_change end
    this.gitOps.dispose()
    this.panel?.dispose()
    this.outputChannel.dispose()
  }
}
