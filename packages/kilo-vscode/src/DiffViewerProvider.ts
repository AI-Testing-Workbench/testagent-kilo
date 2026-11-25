import * as vscode from "vscode"
import type { KiloConnectionService } from "./services/cli-backend"
import { buildWebviewHtml } from "./utils"
import { GitOps } from "./agent-manager/GitOps"
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
  // testagent_change start - webview 就绪标记,用于隐藏后重新可见时恢复轮询
  private ready = false
  // testagent_change end

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionService: KiloConnectionService,
  ) {
    this.gitOps = new GitOps({ log: (...args) => this.log(...args) })
    this.outputChannel = vscode.window.createOutputChannel("TestAgent Diff Viewer")
  }

  private log(...args: unknown[]) {
    appendOutput(this.outputChannel, "DiffViewer", ...args)
  }

  public setCommentHandler(handler: (comments: unknown[], autoSend: boolean) => void): void {
    this.onSendComments = handler
  }

  public openPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One)
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
    this.ready = false

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-light.png"),
      dark: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-dark.png"),
    }

    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), undefined, [])
    panel.webview.html = this.getHtml(panel.webview)

    // testagent_change start - 面板隐藏即停止 2.5s diff 轮询,重新可见时恢复;retainContextWhenHidden 下 webview 不会再发 webviewReady
    panel.onDidChangeViewState(
      (e) => {
        if (!e.webviewPanel.visible) {
          this.stopDiffPolling()
          return
        }
        if (this.ready && !this.diffInterval) this.startDiffPolling()
      },
      undefined,
      [],
    )
    // testagent_change end

    panel.onDidDispose(() => {
      this.log("Panel disposed")
      this.stopDiffPolling()
      this.panel = undefined
    })
  }

  private onMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string

    if (type === "webviewReady") {
      this.ready = true
      this.post({
        type: "ready",
        serverInfo: this.connectionService.getServerInfo(), // testagent_change - add serverInfo
        vscodeLanguage: vscode.env.language,
        languageOverride: vscode.workspace.getConfiguration("testagent.new").get<string>("language"),
        workspaceDirectory: getWorkspaceRoot(),
      })
      this.startDiffPolling()
      return
    }

    if (type === "diffViewer.sendComments" && Array.isArray(msg.comments)) {
      this.onSendComments?.(msg.comments, !!msg.autoSend)
      return
    }

    if (type === "diffViewer.close") {
      this.panel?.dispose()
      return
    }

    if (type === "diffViewer.setDiffStyle" && (msg.style === "unified" || msg.style === "split")) {
      return
    }

    if (type === "diffViewer.revertFile" && typeof msg.file === "string") {
      void this.revertFile(msg.file)
      return
    }

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
      await this.connectionService.connect(target.directory)
      const client = this.connectionService.getClient()
      const response = await client.worktree.diff(
        { directory: target.directory, base: target.baseBranch },
        { throwOnError: true },
      )
      // testagent_change start - handle non-array response
      const diffs = Array.isArray(response.data) ? response.data : []
      // testagent_change end

      this.lastDiffHash = hashFileDiffs(diffs)
      this.log(`Initial diff: ${diffs.length} file(s)`)
      this.post({ type: "diffViewer.diffs", diffs })
    } catch (err) {
      this.log("Failed to fetch initial diff:", err)
      this.post({ type: "diffViewer.diffs", diffs: [] }) // testagent_change - send empty array on error
    } finally {
      this.post({ type: "diffViewer.loading", loading: false })
    }
  }

  private async pollDiff(): Promise<void> {
    const target = this.cachedDiffTarget
    if (!target) {
      await this.initialFetch()
      return
    }

    try {
      const client = this.connectionService.getClient()
      const { data: diffs } = await client.worktree.diff(
        { directory: target.directory, base: target.baseBranch },
        { throwOnError: true },
      )

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
    this.gitOps.dispose()
    this.panel?.dispose()
    this.outputChannel.dispose()
  }
}
