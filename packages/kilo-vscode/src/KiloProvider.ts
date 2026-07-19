/* eslint-disable max-lines */
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import * as vscode from "vscode"
import * as jsonc from "jsonc-parser"
import { fileURLToPath } from "url"
import { buildPreviewPath, getPreviewCommand, getPreviewDir, parseImage, trimEntries } from "./image-preview"
import { isAbsolutePath, isManagedPluginLocation, isManagedSkillLocation } from "./path-utils"
import type {
  KiloClient,
  Session,
  SessionStatus,
  Event,
  TextPartInput,
  FilePartInput,
  Config,
} from "@kilocode/sdk/v2/client"
import { type KiloConnectionService, type KilocodeNotification, ServerStartupError } from "./services/cli-backend"
import type { EditorContext } from "./services/cli-backend/types"
import { FileIgnoreController } from "./services/autocomplete/shims/FileIgnoreController"
import { ChatTextAreaAutocomplete } from "./services/autocomplete/chat-autocomplete/ChatTextAreaAutocomplete"
import { buildWebviewHtml } from "./utils"
import { TelemetryProxy, type TelemetryPropertiesProvider } from "./services/telemetry"
import { SystemNotificationService } from "./services/system-notification" // testagent_change
import {
  sessionToWebview,
  indexProvidersById,
  filterVisibleAgents,
  buildSettingPath,
  mapSSEEventToWebviewMessage,
  getErrorMessage,
  getConfigErrorDetails,
  isEventFromForeignProject,
  MessageConfirmation,
  runWithMessageConfirmation,
  loadSessions as loadSessionsUtil,
  flushPendingSessionRefresh as flushPendingSessionRefreshUtil,
  resolveContextDirectory,
  resolveWorkspaceDirectory,
  SessionStreamScheduler,
  type SessionRefreshContext,
} from "./kilo-provider-utils"
import { GitOps } from "./agent-manager/GitOps"
import { GitStatsPoller, type LocalStats } from "./agent-manager/GitStatsPoller"
import { diffSummary as localDiffSummary } from "./agent-manager/local-diff"
import { getWorkspaceRoot } from "./review-utils"
import { MarketplaceService, type MarketplaceItem, type RemoveResult } from "./services/marketplace"
import type { RemoteStatusService } from "./services/RemoteStatusService"
import { resolveProjectDirectory } from "./project-directory"
import { getBusySessionCount, seedSessionStatuses } from "./session-status"
import { retry } from "./services/cli-backend/retry"
import { slimPart, slimParts } from "./kilo-provider/slim-metadata"
import { handleContinueInWorktree } from "./kilo-provider/continue-worktree"
import { parseMessageFiles, type MessageFile } from "./kilo-provider/message-files"
import { handleFileSearch } from "./kilo-provider/file-search"
import { getTerminalContents } from "./services/terminal/context"
import { matchFollowup, recordFollowup, type Followup } from "./kilo-provider/followup-session"
import { clearCommandsCache, loadCommands } from "./kilo-provider/commands"
import { fetchMessagePage, MESSAGE_PAGE_LIMIT } from "./kilo-provider/message-page"
import { childID } from "./kilo-provider/task-session"
import { handleNetworkEvent, clearNetworkWaits } from "./kilo-provider/network"
import { abortSession, parseQueued } from "./kilo-provider/abort"
import * as ModelState from "./kilo-provider/model-state"
import { handleForkSession } from "./kilo-provider/fork-session"
import { retryable, backoff, MAX_RETRIES } from "./util/retry"
import { hasGit } from "./kilo-provider/git-status"
import { exec } from "./util/process"
// testagent_change start - testflow integration
import { SdtRunner } from "./testagent/sdt-runner"
import { runTaskCommand } from "./testagent/task-runner"
import { handleInteractiveRun } from "./testagent/sdt-interactive-runner"
import { handleRequestStages } from "./testagent/sdt-stages-handler"
// testagent_change end
// legacy-migration start
import {
  checkAndShowMigrationWizard,
  handleRequestLegacyMigrationData,
  handleStartLegacyMigration,
  handleFinalizeLegacyMigration,
  handleSkipLegacyMigration,
  handleClearLegacyData,
  type MigrationContext,
} from "./kilo-provider/handlers/migration"
// legacy-migration end
import {
  handleLogin,
  handleLogout,
  handleSetOrganization,
  handleRefreshProfile,
  type AuthContext,
} from "./kilo-provider/handlers/auth"
import {
  handleRequestCloudSessions,
  handleRequestCloudSessionData,
  handleImportAndSend,
  type CloudSessionContext,
} from "./kilo-provider/handlers/cloud-session"
import {
  handlePermissionResponse,
  fetchAndSendPendingPermissions,
  type PermissionContext,
} from "./kilo-provider/handlers/permission-handler"
import {
  handleQuestionReply,
  handleQuestionReject,
  fetchAndSendPendingQuestions,
} from "./kilo-provider/handlers/question"
import { fetchAndSendPendingSuggestions, routeSuggestionWebviewMessage } from "./kilo-provider/handlers/suggestion"

import {
  buildActionContext,
  computeDefaultSelection,
  fetchProviderData,
  validateRecents,
  validateFavorites,
  connectProvider as connectProviderAction,
  authorizeProviderOAuth as authorizeOAuthAction,
  completeProviderOAuth as completeOAuthAction,
  disconnectProvider as disconnectProviderAction,
  saveCustomProvider as saveCustomProviderAction,
} from "./provider-actions"
import { fetchOpenAIModels, FetchModelsError } from "./shared/fetch-models"
import type { Agent } from "@kilocode/sdk/v2/client"

type KiloProviderOptions = {
  projectDirectory?: string | null
  slimEditMetadata?: boolean
}

type ConfigPatch = Partial<Config> & {
  default_agent?: string | null
}

type MessageLoadMode = "replace" | "prepend" | "focus" | "reconcile"

type MemorySettingsConfig = {
  enable: boolean
  debug: boolean
  cmd: {
    memory: boolean
    dream: boolean
  }
  memory: {
    autoExtractMaxLength: number
    autoExtractBufferSize: number
    personalMemoryEnable: boolean
    personalMemoryPrompt: string
    autoDreamEnable: boolean
    autoExtractEnable: boolean
  }
  recall: {
    recallEnable: boolean
    llmRecall: boolean
    providerID: string
    modelID: string
  }
}

const memoryDefaults: MemorySettingsConfig = {
  enable: false,
  debug: false,
  cmd: {
    memory: true,
    dream: true,
  },
  memory: {
    autoExtractMaxLength: 10000,
    autoExtractBufferSize: 10,
    personalMemoryEnable: true,
    personalMemoryPrompt: "",
    autoDreamEnable: true,
    autoExtractEnable: true,
  },
  recall: {
    recallEnable: true,
    llmRecall: false,
    providerID: "",
    modelID: "",
  },
}

const memoryPath = () => path.join(os.homedir(), ".config", "testagent", "testagent-memory.json")

const memorySettings = (input: unknown): MemorySettingsConfig => {
  const cfg = input && typeof input === "object" ? (input as Partial<MemorySettingsConfig>) : {}
  return {
    enable: typeof cfg.enable === "boolean" ? cfg.enable : memoryDefaults.enable,
    debug: typeof cfg.debug === "boolean" ? cfg.debug : memoryDefaults.debug,
    cmd: {
      memory: typeof cfg.cmd?.memory === "boolean" ? cfg.cmd.memory : memoryDefaults.cmd.memory,
      dream: typeof cfg.cmd?.dream === "boolean" ? cfg.cmd.dream : memoryDefaults.cmd.dream,
    },
    memory: {
      autoExtractMaxLength:
        typeof cfg.memory?.autoExtractMaxLength === "number"
          ? cfg.memory.autoExtractMaxLength
          : memoryDefaults.memory.autoExtractMaxLength,
      autoExtractBufferSize:
        typeof cfg.memory?.autoExtractBufferSize === "number"
          ? cfg.memory.autoExtractBufferSize
          : memoryDefaults.memory.autoExtractBufferSize,
      personalMemoryEnable:
        typeof cfg.memory?.personalMemoryEnable === "boolean"
          ? cfg.memory.personalMemoryEnable
          : memoryDefaults.memory.personalMemoryEnable,
      personalMemoryPrompt:
        typeof cfg.memory?.personalMemoryPrompt === "string"
          ? cfg.memory.personalMemoryPrompt
          : memoryDefaults.memory.personalMemoryPrompt,
      autoDreamEnable:
        typeof cfg.memory?.autoDreamEnable === "boolean"
          ? cfg.memory.autoDreamEnable
          : memoryDefaults.memory.autoDreamEnable,
      autoExtractEnable:
        typeof cfg.memory?.autoExtractEnable === "boolean"
          ? cfg.memory.autoExtractEnable
          : memoryDefaults.memory.autoExtractEnable,
    },
    recall: {
      recallEnable:
        typeof cfg.recall?.recallEnable === "boolean" ? cfg.recall.recallEnable : memoryDefaults.recall.recallEnable,
      llmRecall: typeof cfg.recall?.llmRecall === "boolean" ? cfg.recall.llmRecall : memoryDefaults.recall.llmRecall,
      providerID: typeof cfg.recall?.providerID === "string" ? cfg.recall.providerID : memoryDefaults.recall.providerID,
      modelID: typeof cfg.recall?.modelID === "string" ? cfg.recall.modelID : memoryDefaults.recall.modelID,
    },
  }
}

// Helper to map agent data to the subset of fields sent to the webview
const mapAgent = (a: Agent) => ({
  name: a.name,
  displayName: a.displayName,
  description: a.description,
  mode: a.mode,
  native: a.native,
  hidden: a.hidden,
  color: a.color,
  deprecated: a.deprecated,
  permission: a.permission,
  model: a.model,
})

// testagent_change: Deep merge for config patches. null in source deletes the key.
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const [key, val] of Object.entries(source)) {
    if (val === null) { delete result[key]; continue }
    if (typeof val === "object" && !Array.isArray(val) && val !== null &&
        typeof result[key] === "object" && !Array.isArray(result[key]) && result[key] !== null) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>)
    } else {
      result[key] = val
    }
  }
  return result
}

// testagent_change: Strip null/undefined values recursively (null = delete sentinel).
function removeNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue
    if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      result[key] = removeNulls(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

// // testagent_change: Structured log channel for config write operations
// const configLog = vscode.window.createOutputChannel("TestAgent Config", { log: true })

// testagent_change start - shared parent-child session tracking across KiloProvider instances
// These must be module-level (not instance-level) because permission.asked / question.asked /
// session.error / session.status events bypass the per-instance trackedSessionIds filter
// and are dispatched to ALL KiloProvider instances. Only the instance that performed
// auto-adoption would know the parent-child relationship; others would duplicate notifications
// or fire completion notifications for child sessions.
const syncedChildSessions: Set<string> = new Set()
const parentWithChildren: Set<string> = new Set()
const childToParent: Map<string, string> = new Map()
/** Deduplicates notifications across KiloProvider instances — event IDs are
 *  added here when first processed and cleaned up after a short delay. */
const notifiedEventIds: Set<string> = new Set()
// testagent_change end

export class KiloProvider implements vscode.WebviewViewProvider, TelemetryPropertiesProvider {
  private _debug_syncedSet: Set<string> | null = null // testagent_change - debug for syncedChildSessions
  public static readonly viewType = "testagent.SidebarProvider" // testagent_change
  private readonly instanceId = crypto.randomUUID()
  private webviewType: "sidebar" | "panel" | "unknown" = "unknown" // testagent_change

  private webview: vscode.Webview | null = null
  private webviewView: vscode.WebviewView | null = null // testagent_change - store view reference for visibility check

  // testagent_change start - System notification service
  private systemNotification: SystemNotificationService
  // testagent_change end
  private currentSession: Session | null = null
  /** Remembers the last selected session so /new can stay in the same worktree after clearSession. */
  private contextSessionID: string | undefined
  private connectionState: "connecting" | "connected" | "disconnected" | "error" = "connecting"
  private loginAttempt = 0
  private isWebviewReady = false
  private readonly extensionVersion =
    vscode.extensions.getExtension("testagent.testagent-tscode")?.packageJSON?.version ?? "unknown"
  /** Cached providersLoaded payload so requestProviders can be served before client is ready */
  private cachedProvidersMessage: unknown = null
  /** Coalesce provider refreshes — at most one follow-up rerun when a request lands mid-flight. */
  private providersRefresh: Promise<void> | null = null
  private providersQueued = false
  private providersGeneration = 0
  /** Cached agentsLoaded payload so requestAgents can be served before client is ready */
  private cachedAgentsMessage: unknown = null
  /** Cached skillsLoaded payload so requestSkills can be served before client is ready */
  private cachedSkillsMessage: unknown = null
  /** Cached commandsLoaded payload so requestCommands can be served before client is ready */
  private cachedCommandsMessage: unknown = null
  /** Cached configLoaded payload so requestConfig can be served before client is ready */
  private cachedConfigMessage: unknown = null
  /** Cached mcpStatusLoaded payload so requestMcpStatus can be served before client is ready */
  private cachedMcpStatusMessage: unknown = null
  /** Ref-count of in-flight handleUpdateConfig calls; prevents fetchAndSendConfig from sending stale data */
  private pending = 0
  private configWarningsShown = false
  /** Cached notificationsLoaded payload */
  private cachedNotificationsMessage: unknown = null
  private pendingReviewComments: { comments: unknown[]; autoSend: boolean }[] = []
  private readyResolvers: (() => void)[] = []
  private promptRecoveryQueued = false
  private promptRecovery: Promise<void> | null = null
  private trackedSessionIds: Set<string> = new Set()
  /** Tracks the latest status for each session, used to warn before destructive config operations. */
  private sessionStatusMap = new Map<string, SessionStatus["type"]>()
  /** Per-session directory overrides (e.g., worktree paths registered by AgentManagerProvider). */
  private sessionDirectories = new Map<string, string>()
  /** Project ID for the current workspace, used to filter out sessions from other repositories. */
  private projectID: string | undefined
  /** Abort controller for the current loadMessages request; aborted when a new session is selected. */
  private loadMessagesAbort: AbortController | null = null
  /** Per-session last focus-mode reconcile timestamp — throttles rapid tab switching. */
  private lastReconciledAt = new Map<string, number>()
  /** Set when refreshSessions() is called before the client is ready.
   *  Cleared and retried once the connection transitions to "connected". */
  private pendingSessionRefresh = false
  private readonly streams = new SessionStreamScheduler((msg) => this.postMessage(msg))
  private readonly confirmations = new MessageConfirmation()
  private unsubscribeEvent: (() => void) | null = null
  private unsubscribeState: (() => void) | null = null
  /** Cached legacy migration data so migrate() doesn't re-read from disk/SecretStorage. */ // legacy-migration
  private cachedLegacyData: import("./legacy-migration/legacy-types").LegacyMigrationData | null = null // legacy-migration
  /** Guard to prevent checkAndShowMigrationWizard running concurrently. */ // legacy-migration
  private migrationCheckInFlight = false // legacy-migration
  private unsubscribeNotificationDismiss: (() => void) | null = null
  private unsubscribeLanguageChange: (() => void) | null = null
  private unsubscribeProfileChange: (() => void) | null = null
  private unsubscribeFavoritesChange: (() => void) | null = null
  private unsubscribeMigrationComplete: (() => void) | null = null // legacy-migration
  private unsubscribeClearPendingPrompts: (() => void) | null = null
  private unsubscribeAgentsChange: (() => void) | null = null // testagent_change
  private unsubscribeDirectoryProvider: (() => void) | null = null
  private initConnectionPromise: Promise<void> | null = null
  private webviewMessageDisposable: vscode.Disposable | null = null
  // testagent_change start - testflow integration
  private readonly sdtRunner = new SdtRunner()
  /** 本地 question 的 deferred 映射表（用于 /sdt-run 交互式阶段选择） */
  private readonly localQuestionMap = new Map<string, {
    deferred: { resolve: (value: string) => void; reject: (reason?: any) => void }
    timeout: NodeJS.Timeout
  }>()
  // testagent_change end
  private viewStateDisposable: vscode.Disposable | null = null
  private visibilityDisposable: vscode.Disposable | null = null

  /** Lazily initialized ignore controller for .testagentignore filtering */ // testagent_change
  private ignoreController: FileIgnoreController | null = null
  private ignoreControllerDir: string | null = null
  private marketplace: MarketplaceService | null = null
  private chatAutocomplete: ChatTextAreaAutocomplete | null = null
  private projectDirectory: string | null | undefined
  private slimEditMetadata = true

  private pendingFollowup: Followup | null = null
  private followupListeners: Array<(session: Session, directory: string) => void> = []
  /** Worktree diff stats poller for the sidebar badge — reuses GitStatsPoller (local stats only) */
  private statsPoller: GitStatsPoller | null = null
  private statsGitOps: GitOps | null = null
  private cachedStats: unknown = null
  private cachedGitRepo = false

  /** Optional interceptor called before the standard message handler.
   *  Return null to consume the message, or return a (possibly transformed) message. */
  private onBeforeMessage: ((msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>) | null = null

  /** Handler for "Continue in Worktree" — set by extension.ts to delegate to AgentManagerProvider. */
  private continueInWorktreeHandler:
    | ((sessionId: string, progress: (status: string, detail?: string, error?: string) => void) => Promise<void>)
    | null = null

  private diffVirtualProvider: import("./DiffVirtualProvider").DiffVirtualProvider | undefined
  private remoteService: RemoteStatusService | null = null
  private unsubscribeRemote: (() => void) | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionService: KiloConnectionService,
    private readonly extensionContext?: vscode.ExtensionContext,
    options?: KiloProviderOptions,
  ) {
    this.projectDirectory = options?.projectDirectory
    this.slimEditMetadata = options?.slimEditMetadata ?? true

    TelemetryProxy.getInstance().setProvider(this)

    // testagent_change start - Initialize system notification service
    this.systemNotification = new SystemNotificationService(extensionUri)
    // testagent_change end

    // testagent_change start - provide current session ID for auto-compaction retry abort
    this.connectionService.setCurrentSessionIdGetter(() => this.currentSession?.id)
    // 当用户点击"确定"开启自动压缩时，走统一 abort 流程
    this.connectionService.onAutoCompaction(() => {
      const sid = this.currentSession?.id
      if (sid) {
        // 直接通知前端 UI 更新状态（cancelRetry 内部依赖 retryAbortControllers，可能没有注册）
        this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
        // 仍然尝试取消本地 retry（如果有的话）
        this.cancelRetry(sid)
        // 不阻塞后续流程，异步执行后端 abort
        this.handleAbort(sid).catch((e) => console.warn("[TestAgent] auto-compaction handleAbort 失败:", e))
      }
    })
    // testagent_change end
  }

  setRemoteService(service: RemoteStatusService): void {
    this.remoteService = service
    this.unsubscribeRemote = service.onChange(() => this.sendRemoteStatus())
  }
  private sendRemoteStatus(): void {
    const s = this.remoteService?.getState()
    if (s) this.postMessage({ type: "remoteStatus", enabled: s.enabled, connected: s.connected })
  }
  private focusSession(id?: string): void {
    this.streams.focus(id)
    if (id) this.connectionService.registerFocused(this.instanceId, id)
    else this.connectionService.unregisterFocused(this.instanceId)
  }

  public setProjectDirectory(directory: string | null): void {
    if (this.projectDirectory === directory) return
    this.projectDirectory = directory
    this.postMessage({ type: "workspaceDirectoryChanged", directory: directory ?? "" })
  }

  public setDiffVirtualProvider(provider: import("./DiffVirtualProvider").DiffVirtualProvider): void {
    this.diffVirtualProvider = provider
  }

  getTelemetryProperties(): Record<string, unknown> {
    return {
      appName: "testagent",
      appVersion: this.extensionVersion,
      platform: "vscode",
      editorName: vscode.env.appName,
      vscodeVersion: vscode.version,
      machineId: vscode.env.machineId,
      vscodeIsTelemetryEnabled: vscode.env.isTelemetryEnabled,
    }
  }

  /**
   * Convenience getter that returns the shared SDK KiloClient or null if not yet connected.
   * Preserves the existing null-check pattern used throughout handler methods.
   */
  private get client(): KiloClient | null {
    try {
      return this.connectionService.getClient()
    } catch {
      return null
    }
  }

  // Strip edit-tool metadata.filediff.before/after (multi-MB for edit-heavy
  // sessions) to keep session switches fast. Logic in kilo-provider/slim-metadata.ts.
  private slimPart<T>(part: T): T {
    if (!this.slimEditMetadata) return part
    return slimPart(part)
  }

  private slimParts<T>(parts: T[]) {
    if (!this.slimEditMetadata) return parts
    return slimParts(parts)
  }

  private get forkCtx() {
    return {
      connection: this.connectionService,
      post: (msg: { type: "error"; message: string }) => this.postMessage(msg),
      register: (session: Session) => this.registerSession(session),
      forked: (session: Session) => this.postMessage({ type: "sessionForked", sessionID: session.id }),
      status: (sessionID: string) => this.sessionStatusMap.get(sessionID),
      directory: (sessionID: string) => this.getWorkspaceDirectory(sessionID),
    }
  }

  private async syncWebviewState(reason: string): Promise<void> {
    const serverInfo = this.connectionService.getServerInfo()
    console.log("[TestAgent]  🔄 syncWebviewState()", {
      reason,
      isWebviewReady: this.isWebviewReady,
      connectionState: this.connectionState,
      hasClient: !!this.client,
      hasServerInfo: !!serverInfo,
    })

    if (!this.isWebviewReady) {
      console.log("[TestAgent]  ⏭️ syncWebviewState skipped (webview not ready)")
      return
    }

    // Always push connection state first so the UI can render appropriately.
    console.log(`[TestAgent]  📤 Posting connectionState: ${this.connectionState}`)
    this.postMessage({
      type: "connectionState",
      state: this.connectionState,
    })

    // Re-send ready so the webview can recover after refresh.
    if (serverInfo) {
      const langConfig = vscode.workspace.getConfiguration("testagent.new")
      console.log("[TestAgent]  📤 Posting ready message with serverInfo")
      this.postMessage({
        type: "ready",
        serverInfo,
        extensionVersion: this.extensionVersion,
        vscodeLanguage: vscode.env.language,
        languageOverride: langConfig.get<string>("language"),
        workspaceDirectory: this.getProjectDirectory(this.currentSession?.id),
        webviewType: this.webviewType, // testagent_change
      })
    } else {
      console.log("[TestAgent]  ⚠️ Skipping ready message (no serverInfo)")
    }

    // Always attempt to fetch+push profile when connected.
    // Profile returns 401 when user isn't logged into Kilo Gateway — that's expected.
    // Use fire-and-forget (no throwOnError) to match old getProfile() which returned null on error.
    if (this.connectionState === "connected" && this.client) {
      // testagent_change start - disable profile API (not available in testagent backend)
      // console.log("[TestAgent]  👤 syncWebviewState fetching profile...")
      // const profileResult = await retry(() => this.client!.kilo.profile())
      // const profileData = profileResult.data ?? null
      // console.log("[TestAgent]  👤 syncWebviewState profile:", profileData ? "received" : "null")
      // this.postMessage({
      //   type: "profileData",
      //   data: profileData,
      // })
      console.log("[TestAgent]  👤 syncWebviewState skipping profile (not available)")
      this.postMessage({
        type: "profileData",
        data: null,
      })
      // testagent_change end

      // Re-send cached worktree stats and git status after webview reload.
      if (this.cachedStats) this.postMessage(this.cachedStats)
      this.postMessage({ type: "gitStatus", repo: this.cachedGitRepo })

      // Seed session status map so the Settings panel knows about already-running sessions.
      // Must run after webview is ready (postMessage is a no-op before that).
      // Only reconcile (reset missing busy→idle) when the map is empty, i.e.
      // on the very first seed before any real-time SSE events have arrived.
      // On SSE reconnects or webview recreations the live SSE data is
      // authoritative and reconciliation risks race-resetting busy sessions.
      const reconcile = this.sessionStatusMap.size === 0
      void this.seedSessionStatusMap(reconcile)

      this.sendRemoteStatus()
    }

    // legacy-migration start
    // Show the migration wizard once the CLI connection is established.
    // Three triggers cover all timing scenarios:
    //   "webviewReady" + connected — webview loaded after SSE was already up
    //   "sse-connected"            — SSE connected after webview was ready
    //   "initializeConnection"     — sidebar path where connect() resolves before
    //                                onStateChange is subscribed, so sse-connected never fires
    if (this.connectionState === "connected") {
      void checkAndShowMigrationWizard(this.migrationCtx)
    }
    // legacy-migration end
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    // Store the webview references
    this.isWebviewReady = false
    this.webview = webviewView.webview
    this.webviewView = webviewView // testagent_change - store view reference
    this.webviewType = "sidebar" // testagent_change

    // Set up webview options
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)
    this.setupWebviewMessageHandler(webviewView.webview)

    vscode.commands.executeCommand("setContext", "testagent.new.sidebarVisible", webviewView.visible)
    this.visibilityDisposable?.dispose()
    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      vscode.commands.executeCommand("setContext", "testagent.new.sidebarVisible", webviewView.visible)
      if (this.statsPoller) {
        this.statsPoller.setEnabled(webviewView.visible)
        this.statsPoller.setVisible(webviewView.visible)
      }
      this.focusSession(webviewView.visible ? this.currentSession?.id : undefined)
    })
    this.initializeConnection()
  }

  /**
   * Resolve a WebviewPanel for displaying the Kilo webview in an editor tab.
   */
  public resolveWebviewPanel(panel: vscode.WebviewPanel): void {
    // WebviewPanel can be restored/reloaded; ensure we don't treat it as ready prematurely.
    this.isWebviewReady = false
    this.webview = panel.webview
    this.webviewType = "panel" // testagent_change

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }

    panel.webview.html = this._getHtmlForWebview(panel.webview)

    this.setupWebviewMessageHandler(panel.webview)
    this.viewStateDisposable?.dispose()
    this.viewStateDisposable = panel.onDidChangeViewState(() =>
      this.focusSession(panel.active ? this.currentSession?.id : undefined),
    )
    this.initializeConnection()
  }

  /**
   * Register a session created externally (e.g., worktree sessions from AgentManagerProvider).
   * Sets currentSession, adds to trackedSessionIds, and notifies the webview.
   */
  public registerSession(session: Session): void {
    this.currentSession = session
    this.contextSessionID = session.id
    this.trackedSessionIds.add(session.id)
    this.postMessage({
      type: "sessionCreated",
      session: this.sessionToWebview(session),
    })
  }

  /**
   * Add a session ID to the tracked set without changing currentSession.
   * Used to re-register worktree sessions after clearSession wipes the set.
   */
  public trackSession(sessionId: string): void {
    this.trackedSessionIds.add(sessionId)
  }

  public loadMessages(sessionID: string): Promise<void> {
    // Sub-agent viewer: full transcript (no "load earlier" UI, no pagination).
    return this.handleLoadMessages(sessionID, { limit: 0 })
  }

  /**
   * Sync a child session to the webview - fetches session info and loads messages.
   * Called when testflow detects a task tool part with a child session ID.
   */
  private async syncChildSession(sessionID: string): Promise<void> {
    const client = this.client
    if (!client) return

    try {
      const dir = this.getContextDirectory()
      const { data: session } = await client.session.get({ sessionID, directory: dir })
      if (!session) {
        console.warn(`[Testflow] Child session ${sessionID} not found`)
        return
      }
      this.trackDirectory(session.id, session.directory)

      // Register session in webview
      this.postMessage({
        type: "sessionCreated",
        session: {
          id: session.id,
          title: session.title,
          parentID: session.parentID,
          directory: session.directory,
          createdAt: new Date().toISOString(),
        },
      })

      // Load session messages
      await this.loadMessages(sessionID)
    } catch (err) {
      console.error(`[Testflow] Failed to sync child session ${sessionID}:`, err)
    }
  }

  /**
   * Register a directory override for a session (e.g., worktree path).
   * When set, all operations for this session use this directory instead of the workspace root.
   */
  public setSessionDirectory(sessionId: string, directory: string): void {
    this.sessionDirectories.set(sessionId, directory)
  }

  public clearSessionDirectory(sessionId: string): void {
    this.sessionDirectories.delete(sessionId)
  }

  /** Exposes the session→directory map so callers outside the webview can resolve worktree paths. */
  public getSessionDirectories(): ReadonlyMap<string, string> {
    return this.sessionDirectories
  }

  /** Return the currently active session ID, if any. */
  public getCurrentSessionId(): string | undefined {
    return this.currentSession?.id ?? undefined
  }

  /**
   * Re-fetch and send the full session list to the webview.
   * Called by AgentManagerProvider after worktree recovery completes.
   */
  public refreshSessions(): void {
    void this.handleLoadSessions()
  }

  /** Register a listener invoked when a plan follow-up session is adopted. */
  public onFollowupAdopted(cb: (session: Session, directory: string) => void): void {
    this.followupListeners.push(cb)
  }

  /** Recover permission/question prompts after sessions and directories are tracked. */
  public recoverPendingPrompts(): void {
    this.promptRecoveryQueued = true
    if (!this.isWebviewReady) return
    if (!this.client) return
    if (this.promptRecovery) return

    this.promptRecovery = this.flushPendingPrompts().finally(() => {
      this.promptRecovery = null
      if (this.promptRecoveryQueued && this.isWebviewReady && this.client) this.recoverPendingPrompts()
    })
  }

  private async flushPendingPrompts(): Promise<void> {
    while (this.promptRecoveryQueued && this.isWebviewReady) {
      if (!this.client) return
      this.promptRecoveryQueued = false
      await Promise.all([
        fetchAndSendPendingPermissions(this.permissionCtx),
        fetchAndSendPendingQuestions(this.questionCtx),
        fetchAndSendPendingSuggestions(this.questionCtx),
      ])
    }
  }

  public openCloudSession(sessionId: string): void {
    this.postMessage({ type: "openCloudSession", sessionId })
  }

  public setContinueInWorktreeHandler(
    handler: (sessionId: string, progress: (status: string, detail?: string, error?: string) => void) => Promise<void>,
  ): void {
    this.continueInWorktreeHandler = handler
  }

  public attachToWebview(
    webview: vscode.Webview,
    options?: { onBeforeMessage?: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null> },
  ): void {
    this.isWebviewReady = false
    this.webview = webview
    this.onBeforeMessage = options?.onBeforeMessage ?? null
    this.setupWebviewMessageHandler(webview)
    this.initializeConnection()
  }

  private setupWebviewMessageHandler(webview: vscode.Webview): void {
    this.webviewMessageDisposable?.dispose()
    this.webviewMessageDisposable = webview.onDidReceiveMessage(async (message) => {
      // Run interceptor if attached (e.g., AgentManagerProvider worktree logic)
      if (this.onBeforeMessage) {
        try {
          const result = await this.onBeforeMessage(message)
          if (result === null) return // consumed by interceptor
          message = result
        } catch (error) {
          console.error("[TestAgent]  interceptor error:", error)
          return
        }
      }

      await routeSuggestionWebviewMessage(this.questionCtx, message)
      if (await ModelState.handleMessage(message.type, message, this.client, (msg) => this.postMessage(msg))) return
      switch (message.type) {
        case "webviewReady":
          console.log("[TestAgent]  ✅ webviewReady received")
          this.isWebviewReady = true
          await this.syncWebviewState("webviewReady")
          this.flushPendingReviewComments()
          this.recoverPendingPrompts()
          this.readyResolvers.splice(0).forEach((r) => r())
          break
        case "sendMessage": {
          const files = parseMessageFiles(message.files)
          await this.handleSendMessage(
            message.text,
            typeof message.messageID === "string" ? message.messageID : undefined,
            message.sessionID,
            typeof message.draftID === "string" ? message.draftID : undefined,
            message.providerID,
            message.modelID,
            message.agent,
            message.variant,
            files,
            message.goal,
          )
          break
        }
        case "sendCommand": {
          const files = parseMessageFiles(message.files)
          await this.handleSendCommand(
            message.command,
            message.arguments,
            typeof message.messageID === "string" ? message.messageID : undefined,
            message.sessionID,
            typeof message.draftID === "string" ? message.draftID : undefined,
            message.providerID,
            message.modelID,
            message.agent,
            message.variant,
            files,
            message.goal,
          )
          break
        }
        // testagent_change start - 添加继续任务处理
        case "continueTask":
          await this.handleContinueTask(message.sessionID, message.messageID, message.providerID, message.modelID)
          break
        // testagent_change end
        case "abort":
          this.cancelRetry(message.sessionID ?? "")
          await this.handleAbort(message.sessionID, parseQueued(message.queuedMessageIDs), message.reason)
          break
        // testagent_change start - testflow message handlers
        case "testflow.syncChildSession":
          await this.syncChildSession(message.sessionID)
          break
        // testagent_change end
        case "revertSession":
          this.handleRevertSession(message.sessionID, message.messageID).catch((e) =>
            console.error("[TestAgent] handleRevertSession failed:", e),
          )
          break
        case "unrevertSession":
          this.handleUnrevertSession(message.sessionID).catch((e) =>
            console.error("[TestAgent] handleUnrevertSession failed:", e),
          )
          break
        case "permissionResponse":
          await handlePermissionResponse(
            this.permissionCtx,
            message.permissionId,
            message.sessionID,
            message.response,
            message.approvedAlways,
            message.deniedAlways,
          )
          break
        case "createSession":
          await this.handleCreateSession()
          break
        case "clearSession":
          this.contextSessionID = this.currentSession?.id ?? this.contextSessionID
          this.currentSession = null
          this.focusSession()
          break
        case "loadMessages":
          // Don't await: allow parallel loads so rapid session switching
          // isn't blocked by slow responses for earlier sessions.
          void this.handleLoadMessages(message.sessionID, {
            mode: message.mode,
            before: message.before,
            limit: message.limit,
          })
          break
        case "syncSession":
          this.handleSyncSession(message.sessionID, message.parentSessionID).catch((e) =>
            console.error("[TestAgent] handleSyncSession failed:", e),
          )
          break
        case "loadSessions":
          this.handleLoadSessions().catch((e) => console.error("[TestAgent] handleLoadSessions failed:", e))
          break
        case "login": {
          const attempt = ++this.loginAttempt
          await handleLogin(this.authCtx, attempt, () => this.loginAttempt)
          break
        }
        case "cancelLogin":
          this.loginAttempt++
          this.postMessage({ type: "deviceAuthCancelled" })
          break
        case "logout":
          await handleLogout(this.authCtx)
          break
        case "setOrganization":
          if (typeof message.organizationId === "string" || message.organizationId === null) {
            await handleSetOrganization(this.authCtx, message.organizationId)
          }
          break
        case "refreshProfile":
          await handleRefreshProfile(this.authCtx)
          break
        case "openExternal":
          this.openExternal(message.url)
          break
        // testagent_change start
        case "openBeeEyes": {
          const ext = vscode.extensions.getExtension("test-tech.beeeyes")
          if (!ext) {
            vscode.window.showErrorMessage("未找到 BeeEyes，请先安装 BeeEyes。")
            break
          }
          await ext.activate()
          await vscode.commands.executeCommand("testTech.beeEyes.openTracing", {
            user_id: message.userId,
            sessionId: message.sessionId,
          })
          break
        }
        // testagent_change end
        case "openSettingsPanel":
          vscode.commands.executeCommand("testagent.new.settingsButtonClicked", message.tab)
          break
        case "openConfigFile":
          this.handleOpenConfigFile(message.scope)
          break
        case "openVSCodeSettings":
          vscode.commands.executeCommand("workbench.action.openSettings", message.query)
          break
        case "openMarketplacePanel":
          vscode.commands.executeCommand("testagent.new.marketplaceButtonClicked", this.projectDirectory)
          break
        case "openChanges":
          vscode.commands.executeCommand("testagent.new.showChanges")
          break
        case "openDiffVirtual":
          this.openDiffVirtual(message.diff)
          break
        case "continueInWorktree":
          handleContinueInWorktree({
            sessionId: message.sessionId,
            handler: this.continueInWorktreeHandler ?? undefined,
            post: (msg) => this.postMessage(msg),
          })
          break
        case "forkSession":
          handleForkSession(this.forkCtx, message.sessionId, message.messageId).catch((e) =>
            console.error("[TestAgent] handleForkSession failed:", e),
          )
          break

        case "retryConnection":
          console.log("[TestAgent]  🔄 Retrying connection...")
          this.initializeConnection().catch((e) => console.error("[TestAgent]  ❌ Retry connection failed:", e))
          break
        case "openSubAgentViewer":
          vscode.commands.executeCommand(
            "testagent.new.openSubAgentViewer",
            message.sessionID,
            message.title,
            this.getWorkspaceDirectory(message.sessionID),
          )
          break
        case "previewImage":
          this.handlePreviewImage(message.dataUrl, message.filename)
          break
        case "exportConversation": // testagent_change
          this.handleExportConversation(message.markdown, message.title).catch((e) =>
            console.error("[TestAgent] handleExportConversation failed:", e),
          )
          break
        case "openFile":
          if (message.filePath) {
            this.handleOpenFile(message.filePath, message.line, message.column)
          }
          break
        case "requestProviders":
          this.fetchAndSendProviders().catch((e) => console.error("[TestAgent] fetchAndSendProviders failed:", e))
          break
        case "connectProvider":
        case "authorizeProviderOAuth":
        case "completeProviderOAuth":
        case "disconnectProvider":
        case "saveCustomProvider":
          await this.handleProviderAction(message)
          break
        case "fetchCustomProviderModels":
          this.handleFetchCustomProviderModels(message).catch((e) =>
            console.error("[TestAgent] fetchCustomProviderModels failed:", e),
          )
          break
        case "compact":
          await this.handleCompact(message.sessionID, message.providerID, message.modelID)
          break
        case "requestAgents":
          this.fetchAndSendAgents().catch((e) => console.error("[TestAgent] fetchAndSendAgents failed:", e))
          break
        case "requestSkills":
          this.fetchAndSendSkills().catch((e) => console.error("[TestAgent] fetchAndSendSkills failed:", e))
          break
        case "requestCommands":
          this.fetchAndSendCommands().catch((e) => console.error("[TestAgent] fetchAndSendCommands failed:", e))
          break
        case "removeSkill":
          this.removeSkill(message.location).catch((e: unknown) => console.error("[TestAgent] removeSkill failed:", e))
          break
        case "removePlugin":
          this.removePlugin(message.location).catch((e: unknown) =>
            console.error("[TestAgent] removePlugin failed:", e),
          )
          break
        case "removeMode":
          this.handleRemoveMode(message.name).catch((e) => console.error("[TestAgent] handleRemoveMode failed:", e))
          break
        case "removeMcp":
          this.handleRemoveMcp(message.name).catch((e) => console.error("[TestAgent] handleRemoveMcp failed:", e))
          break
        case "requestMcpStatus":
          this.fetchAndSendMcpStatus().catch((e) => console.error("[TestAgent] fetchAndSendMcpStatus failed:", e))
          break
        case "connectMcp":
          this.handleConnectMcp(message.name).catch((e) => console.error("[TestAgent] handleConnectMcp failed:", e))
          break
        case "disconnectMcp":
          this.handleDisconnectMcp(message.name).catch((e) =>
            console.error("[TestAgent] handleDisconnectMcp failed:", e),
          )
          break

        case "questionReply":
          // testagent_change start - 本地 question（sdt-local: 前缀）不走 server
          if (typeof message.requestID === 'string' && message.requestID.startsWith('sdt-local:')) {
            const entry = this.localQuestionMap.get(message.requestID)
            if (entry) {
              const label = message.answers?.[0]?.[0]
              if (label) {
                entry.deferred.resolve(label)
              } else {
                entry.deferred.reject(new Error('未选择阶段'))
              }
            }
            break
          }
          // testagent_change end
          this.noteFollowup(message.answers, message.sessionID)
          if (!(await handleQuestionReply(this.questionCtx, message.requestID, message.answers, message.sessionID))) {
            this.pendingFollowup = null
          }
          break
        case "questionReject":
          // testagent_change start - 本地 question（sdt-local: 前缀）不走 server
          if (typeof message.requestID === 'string' && message.requestID.startsWith('sdt-local:')) {
            const entry = this.localQuestionMap.get(message.requestID)
            if (entry) {
              entry.deferred.reject(new Error('用户取消了选择'))
            }
            break
          }
          // testagent_change end
          this.pendingFollowup = null
          await handleQuestionReject(this.questionCtx, message.requestID, message.sessionID)
          break
        case "requestConfig":
          this.fetchAndSendConfig().catch((e) => console.error("[TestAgent] fetchAndSendConfig failed:", e))
          break
        case "requestGlobalConfig":
          this.fetchAndSendGlobalConfig().catch((e) => console.error("[TestAgent] fetchAndSendGlobalConfig failed:", e))
          break
        case "requestMemorySettings":
          this.sendMemorySettings().catch((e) => console.error("[TestAgent] sendMemorySettings failed:", e))
          break
        case "updateMemorySettings":
          this.saveMemorySettings(message.settings).catch((e) =>
            console.error("[TestAgent] saveMemorySettings failed:", e),
          )
          break
        case "checkGitInstalled": {
          const installed = await this.checkGitInstalled()
          if (this.webview) {
            this.webview.postMessage({ type: "gitInstalledResult", installed })
          }
          break
        }
        case "resolveShellPath": {
          const { name } = message
          const path = await this.resolveShell(name)
          this.webview?.postMessage({ type: "shellPathResolved", name, path })
          break
        }
        // testagent_change start - available terminals
        case "getAvailableTerminals": {
          const terminals = await this.getAvailableTerminals()
          this.webview?.postMessage({ type: "availableTerminalsResult", terminals })
          break
        }
        // testagent_change end
        // testagent_change start - npm registry
        case "getNpmRegistry": {
          try {
            const { execSync } = require("child_process")
            const registry = execSync("npm config get registry", { encoding: "utf-8", timeout: 5000 }).trim()
            this.webview?.postMessage({ type: "npmRegistryResult", registry })
          } catch (err) {
            this.webview?.postMessage({ type: "npmRegistryResult", registry: "https://registry.npmjs.org/" })
          }
          break
        }
        case "setNpmRegistry": {
          const { registry } = message
          try {
            const npmrcPath = path.join(os.homedir(), ".npmrc")
            let content = ""
            try {
              content = fs.readFileSync(npmrcPath, "utf-8")
            } catch {
              // file doesn't exist yet
            }

            if (!registry) {
              // 选择"系统默认源" → 删除 ~/.npmrc 中的 registry= 行
              content = content.replace(/^registry\s*=.*$/m, "").replace(/\n{2,}/g, "\n").trim()
              if (!content) {
                try { fs.unlinkSync(npmrcPath) } catch {}
              } else {
                fs.writeFileSync(npmrcPath, content + "\n", "utf-8")
              }
              // 重新读取实际生效的默认值
              const { execSync } = require("child_process")
              const defaultRegistry = execSync("npm config get registry", { encoding: "utf-8", timeout: 5000 }).trim()
              this.webview?.postMessage({ type: "npmRegistryResult", registry: defaultRegistry })
            } else {
              if (content.match(/^registry\s*=/m)) {
                content = content.replace(/^registry\s*=.*$/m, `registry=${registry}`)
              } else {
                content += (content ? "\n" : "") + `registry=${registry}`
              }
              fs.writeFileSync(npmrcPath, content, "utf-8")
              this.webview?.postMessage({ type: "npmRegistryResult", registry })
            }
          } catch (err) {
            console.error("[TestAgent] Failed to set npm registry:", err)
            vscode.window.showErrorMessage(`设置 npm 源失败: ${err}`)
          }
          break
        }
        // testagent_change end
        // testagent_change start - runtime switching
        case "getRuntime": {
          if (!this.extensionContext) {
            console.warn("[TestAgent] No extension context available for getRuntime")
            break
          }
          const runtime = this.connectionService.getCurrentRuntime(this.extensionContext)
          this.webview?.postMessage({ type: "runtimeResult", runtime })
          break
        }
        case "changeRuntime": {
          if (!this.extensionContext) {
            vscode.window.showErrorMessage("Extension context not available")
            break
          }
          const { runtime } = message
          try {
            await this.connectionService.switchRuntime(this.extensionContext, runtime)
            this.webview?.postMessage({ type: "runtimeResult", runtime })
            vscode.window.showInformationMessage(`已切换到 ${runtime === "bun" ? "Bun" : "Node.js"} 运行时`)
          } catch (error) {
            vscode.window.showErrorMessage(`切换运行时失败: ${error}`)
          }
          break
        }
        // testagent_change end
        case "updateConfig":
          await this.handleUpdateConfig(message.config)
          break
        case "setLanguage":
          await vscode.workspace
            .getConfiguration("testagent.new")
            .update("language", message.locale || undefined, vscode.ConfigurationTarget.Global)
          this.connectionService.notifyLanguageChanged(message.locale as string)
          break
        case "requestAutocompleteSettings":
          this.sendAutocompleteSettings()
          break
        case "updateAutocompleteSetting": {
          const allowedKeys = new Set([
            "enableAutoTrigger",
            "enableSmartInlineTaskKeybinding",
            "enableChatAutocomplete",
          ])
          if (allowedKeys.has(message.key)) {
            await vscode.workspace
              .getConfiguration("testagent.new.autocomplete")
              .update(message.key, false, vscode.ConfigurationTarget.Global)
            this.sendAutocompleteSettings()
          }
          break
        }
        case "requestChatCompletion": {
          if (!this.chatAutocomplete) {
            this.chatAutocomplete = new ChatTextAreaAutocomplete(this.connectionService)
          }
          void this.chatAutocomplete.handle(
            { type: "requestChatCompletion", text: message.text, requestId: message.requestId },
            {
              postMessage: (msg: { type: "chatCompletionResult"; text: string; requestId: string }) =>
                this.postMessage(msg),
            },
          )
          break
        }
        case "requestFileSearch":
          await handleFileSearch({
            client: this.client,
            message,
            current: this.currentSession?.id,
            context: this.contextSessionID,
            dir: (id) => this.getWorkspaceDirectory(id),
            open: (dir) => this.getOpenTabPaths(dir),
            post: (msg) => this.postMessage(msg),
          })
          break
        // testagent_change start - /sdt-run 阶段列表查询
        case "requestStages":
          await handleRequestStages(
            {
              getWorkspaceDirectory: (id) => this.getWorkspaceDirectory(id),
              postMessage: (msg) => this.postMessage(msg),
            },
            message,
          )
          break
        // testagent_change end
        case "requestTerminalContext":
          void this.handleTerminalContext(message.requestId)
          break
        case "chatCompletionAccepted":
          this.chatAutocomplete?.telemetry.captureAcceptSuggestion(message.suggestionLength)
          break
        case "toggleRemote":
        case "setRemoteEnabled":
        case "requestRemoteStatus":
          this.handleRemoteMessage(message.type, message.enabled)
          break
        case "restartServer":
          void this.handleRestartServer(message.logLevel)
          break
        // testagent_change start - reload commands
        case "reloadSkills":
          void vscode.commands.executeCommand("testagent.new.reloadSkills")
          break
        case "reloadMcp":
          void vscode.commands.executeCommand("testagent.new.reloadMcp")
          break
        // testagent_change end
        case "deleteSession":
          await this.handleDeleteSession(message.sessionID)
          break
        case "renameSession":
          await this.handleRenameSession(message.sessionID, message.title)
          break
        case "updateSetting":
          await this.handleUpdateSetting(message.key, message.value)
          break
        case "requestBrowserSettings":
          this.sendBrowserSettings()
          break
        case "requestClaudeCompatSetting":
          this.sendClaudeCompatSetting()
          break
        case "requestNotificationSettings":
          this.sendNotificationSettings()
          break
        case "requestTimelineSetting":
          this.sendTimelineSetting()
          break
        // case "requestNotifications":
        //   this.fetchAndSendNotifications().catch((e) =>
        //     console.error("[TestAgent] fetchAndSendNotifications failed:", e),
        //   )
        //   break
        case "requestCloudSessions":
          await handleRequestCloudSessions(this.cloudSessionCtx, message)
          break
        case "requestGitRemoteUrl":
          void this.getGitRemoteUrl().then((url) => {
            this.postMessage({ type: "gitRemoteUrlLoaded", gitUrl: url ?? null })
          })
          break
        case "requestCloudSessionData":
          void handleRequestCloudSessionData(this.cloudSessionCtx, message.sessionId)
          break
        case "importAndSend": {
          const files = parseMessageFiles(message.files)
          void handleImportAndSend(
            this.cloudSessionCtx,
            message.cloudSessionId,
            message.text,
            typeof message.messageID === "string" ? message.messageID : undefined,
            message.providerID,
            message.modelID,
            message.agent,
            message.variant,
            files,
            typeof message.command === "string" ? message.command : undefined,
            typeof message.commandArgs === "string" ? message.commandArgs : undefined,
            message.goal,
          )
          break
        }
        case "dismissNotification":
          await this.handleDismissNotification(message.notificationId)
          break
        case "resetAllSettings":
          await this.handleResetAllSettings()
          break
        case "telemetry":
          TelemetryProxy.capture(message.event, message.properties)
          break
        case "persistVariant": {
          const stored = this.extensionContext?.globalState.get<Record<string, string>>("variantSelections") ?? {}
          stored[message.key] = message.value
          await this.extensionContext?.globalState.update("variantSelections", stored)
          break
        }
        case "requestVariants": {
          const variants = this.extensionContext?.globalState.get<Record<string, string>>("variantSelections") ?? {}
          this.postMessage({ type: "variantsLoaded", variants })
          break
        }
        case "persistRecents":
          await this.extensionContext?.globalState.update("recentModels", validateRecents(message.recents))
          break
        case "requestRecents": {
          const recents = validateRecents(this.extensionContext?.globalState.get("recentModels"))
          this.postMessage({ type: "recentsLoaded", recents })
          break
        }
        case "toggleFavorite": {
          const current = validateFavorites(this.extensionContext?.globalState.get("favoriteModels"))
          const key = `${message.providerID}/${message.modelID}`
          const exists = current.some((f) => `${f.providerID}/${f.modelID}` === key)
          const favorites =
            message.action === "add" && !exists
              ? [...current, { providerID: message.providerID, modelID: message.modelID }]
              : message.action === "remove" && exists
                ? current.filter((f) => `${f.providerID}/${f.modelID}` !== key)
                : current
          await this.extensionContext?.globalState.update("favoriteModels", favorites)
          this.connectionService.notifyFavoritesChanged(favorites)
          break
        }
        case "requestFavorites": {
          const favorites = validateFavorites(this.extensionContext?.globalState.get("favoriteModels"))
          this.postMessage({ type: "favoritesLoaded", favorites })
          break
        }
        // legacy-migration start
        case "requestLegacyMigrationData":
          void handleRequestLegacyMigrationData(this.migrationCtx)
          break
        case "startLegacyMigration":
          void handleStartLegacyMigration(this.migrationCtx, message.selections)
          break
        case "skipLegacyMigration":
          void handleSkipLegacyMigration(this.migrationCtx)
          break
        case "clearLegacyData":
          void handleClearLegacyData(this.migrationCtx)
          break
        case "finalizeLegacyMigration":
          void handleFinalizeLegacyMigration(this.migrationCtx)
          break
        // legacy-migration end
        case "enhancePrompt": {
          const sdkClient = this.client
          if (!sdkClient) {
            this.postMessage({
              type: "enhancePromptError",
              error: "Not connected to CLI backend",
              requestId: message.requestId,
            })
            break
          }
          void sdkClient.enhancePrompt
            .enhance({ text: message.text }, { throwOnError: true })
            .then(({ data }) => {
              this.postMessage({ type: "enhancePromptResult", text: data.text, requestId: message.requestId })
            })
            .catch((err: unknown) => {
              const msg = getErrorMessage(err) || "Failed to enhance prompt"
              console.error("[TestAgent]  Failed to enhance prompt:", err)
              vscode.window.showErrorMessage(`Enhance prompt failed: ${msg}`)
              this.postMessage({
                type: "enhancePromptError",
                error: msg,
                requestId: message.requestId,
              })
            })
          break
        }
        case "fetchMarketplaceData": {
          const workspace = this.getProjectDirectory(this.currentSession?.id)
          const mp = this.getMarketplace()
          // Fetch skills from CLI backend (authoritative source) so the
          // marketplace doesn't need to duplicate the CLI's skill scanning.
          const skills = await this.fetchCliSkills()
          const data = await mp.fetchData(workspace, skills)
          this.postMessage({ type: "marketplaceData", ...data })
          break
        }
        case "filterMarketplaceItems": {
          // Client-side filtering — no server action needed
          break
        }
        case "installMarketplaceItem": {
          const workspace = this.getProjectDirectory(this.currentSession?.id)
          const scope = message.mpInstallOptions?.target ?? "project"
          const result = await this.getMarketplace().install(message.mpItem, message.mpInstallOptions, workspace)
          if (result.success) {
            await this.invalidateAfterMarketplaceChange(scope)
          }
          this.postMessage({
            type: "marketplaceInstallResult",
            success: result.success,
            slug: result.slug,
            error: result.error,
          })
          break
        }
        case "removeInstalledMarketplaceItem": {
          const scope = message.mpInstallOptions?.target ?? "project"
          const result = await this.removeMarketplaceItem(message.mpItem, scope)
          this.postMessage({
            type: "marketplaceRemoveResult",
            success: result.success,
            slug: result.slug,
            error: result.error,
          })
          break
        }
      }
    })
  }

  private openExternal(url: unknown): void {
    if (typeof url !== "string") return
    void vscode.env.openExternal(vscode.Uri.parse(url))
  }

  private openDiffVirtual(diff: unknown): void {
    if (!this.diffVirtualProvider || !diff) return
    this.diffVirtualProvider.open(diff as import("./DiffVirtualProvider").DiffVirtualFile)
  }

  /**
   * Initialize connection to the CLI backend server.
   * Subscribes to the shared KiloConnectionService.
   */
  private initializeConnection(): Promise<void> {
    if (this.initConnectionPromise) {
      return this.initConnectionPromise
    }
    this.initConnectionPromise = this.doInitializeConnection().finally(() => {
      this.initConnectionPromise = null
    })
    return this.initConnectionPromise
  }

  private async doInitializeConnection(): Promise<void> {
    console.log("[TestAgent]  🔧 Starting initializeConnection...")

    this.connectionState = "connecting"
    this.postMessage({ type: "connectionState", state: "connecting" })

    // Clean up any existing subscriptions (e.g., sidebar re-shown)
    this.unsubscribeEvent?.()
    this.unsubscribeState?.()
    this.unsubscribeNotificationDismiss?.()
    this.unsubscribeLanguageChange?.()
    this.unsubscribeProfileChange?.()
    this.unsubscribeFavoritesChange?.()
    this.unsubscribeClearPendingPrompts?.()
    this.unsubscribeAgentsChange?.() // testagent_change
    this.unsubscribeDirectoryProvider?.()

    try {
      const workspaceDir = this.getWorkspaceDirectory()

      // Connect the shared service (no-op if already connected)
      await this.connectionService.connect(workspaceDir)

      // Subscribe to SSE events for this webview (filtered by tracked sessions)
      this.unsubscribeEvent = this.connectionService.onEventFiltered(
        (event) => {
          const et = (event as any).type as string
          // Remote status events are global and should always pass through
          if (et === "kilo-sessions.remote-status-changed") return true
          const sessionId = this.connectionService.resolveEventSessionId(event)

          // message.part.updated and message.part.delta are always session-scoped; drop if session unknown.
          if (!sessionId) {
            return et !== "message.part.updated" && et !== "message.part.delta"
          }

          if (et === "session.created" && (event as any).properties.info) {
            return true
          }

          // session.status must always pass through — even for sessions not tracked by this
          // KiloProvider instance. The Settings panel is a separate provider with no tracked
          // sessions, but it needs session.status to populate sessionStatusMap and allStatusMap
          // for the busy-session warning on Save.
          if (et === "session.status") return true

          // testagent_change start - session.info events should pass through (global notifications)
          if (et === "session.info") return true
          // testagent_change end

          // testagent_change start - Allow blocking events from potential child sessions
          // through the filter so they aren't dropped before auto-adoption completes.
          if (et === "permission.asked" || et === "question.asked" || et === "session.error") return true
          // testagent_change end

          return this.trackedSessionIds.has(sessionId)
        },
        (event) => {
          this.handleEvent(event)
        },
      )

      // Subscribe to connection state changes
      this.unsubscribeState = this.connectionService.onStateChange(async (state) => {
        this.connectionState = state
        this.postMessage({ type: "connectionState", state })

        if (state === "connected") {
          // Fire config warnings independently so a failure in the
          // sequential await chain doesn't prevent warnings from being shown
          // void this.checkConfigWarnings("state")
          try {
            // testagent_change start - disable profile API (not available in testagent backend)
            // Profile fetch is best-effort — returns 401 when user isn't logged into gateway.
            // const sdkClient = this.client
            // if (sdkClient) {
            //   const profileResult = await sdkClient.kilo.profile()
            //   this.postMessage({ type: "profileData", data: profileResult.data ?? null })
            // }
            console.log("[TestAgent]  👤 Skipping profile fetch (not available)")
            this.postMessage({ type: "profileData", data: null })
            // testagent_change end
            await this.syncWebviewState("sse-connected")
            // testagent_change start - force session status reconcile after SSE
            // reconnect. Without this, idle events lost during the disconnect
            // window leave the webview thinking the session is still busy.
            await this.reconcileSessionStatusesOnReconnect()
            // testagent_change end
            await this.flushPendingSessionRefresh("sse-connected")
            this.recoverPendingPrompts()
          } catch (error) {
            console.error("[TestAgent]  ❌ Failed during connected state handling:", error)
            this.postMessage({
              type: "error",
              message: getErrorMessage(error) || "Failed to sync after connecting",
            })
          }
        }
      })

      // Subscribe to notification dismiss broadcast from other KiloProvider instances
      // this.unsubscribeNotificationDismiss = this.connectionService.onNotificationDismissed(() => {
      //   this.fetchAndSendNotifications()
      // })

      // Subscribe to language change broadcast from other KiloProvider instances
      this.unsubscribeLanguageChange = this.connectionService.onLanguageChanged((locale) => {
        this.postMessage({ type: "languageChanged", locale })
      })

      // Subscribe to profile change broadcast from other KiloProvider instances
      this.unsubscribeProfileChange = this.connectionService.onProfileChanged((data) => {
        this.postMessage({ type: "profileData", data })
      })

      // Subscribe to favorites change broadcast from other KiloProvider instances
      this.unsubscribeFavoritesChange = this.connectionService.onFavoritesChanged((favorites) => {
        this.postMessage({ type: "favoritesLoaded", favorites })
      })

      // legacy-migration start
      // Subscribe to migration-complete broadcast from any KiloProvider instance
      this.unsubscribeMigrationComplete = this.connectionService.onMigrationComplete(() => {
        this.postMessage({ type: "migrationState", needed: false })
      })
      // legacy-migration end

      // Subscribe to clear-pending-prompts broadcast (fired after config save drains prompts)
      this.unsubscribeClearPendingPrompts = this.connectionService.onClearPendingPrompts(() => {
        this.postMessage({ type: "clearPendingPrompts" })
      })

      // testagent_change start - Subscribe to agents change broadcast from other KiloProvider instances
      this.unsubscribeAgentsChange = this.connectionService.onAgentsChanged(() => {
        void this.fetchAndSendAgents()
      })
      // testagent_change end

      // Register this provider's directories so drainPendingPrompts() covers all instances
      this.unsubscribeDirectoryProvider = this.connectionService.registerDirectoryProvider(() => {
        return [this.getWorkspaceDirectory(), ...this.sessionDirectories.values()]
      })

      // Get current state and push to webview
      const serverInfo = this.connectionService.getServerInfo()
      this.connectionState = this.connectionService.getConnectionState()

      if (serverInfo) {
        const langConfig = vscode.workspace.getConfiguration("testagent.new")
        // testagent_change start - include userId in ready message
        let userId: string | undefined
        try {
          const session = await vscode.authentication.getSession("tscode-oauth", [], { createIfNone: false })
          userId = session?.account.id
        } catch {
          // non-critical
        }
        // testagent_change end
        this.postMessage({
          type: "ready",
          serverInfo,
          extensionVersion: this.extensionVersion,
          vscodeLanguage: vscode.env.language,
          languageOverride: langConfig.get<string>("language"),
          workspaceDirectory: this.getProjectDirectory(this.currentSession?.id),
          userId, // testagent_change
        })
      }

      this.postMessage({ type: "connectionState", state: this.connectionState })

      // connect() can resolve after SSE reaches "connected" but before this
      // provider subscribes to onStateChange(). In that case the initial
      // connected callback is missed, so run the warning check here too.
      if (this.connectionState === "connected") {
        // void this.checkConfigWarnings("init")
      }

      await this.syncWebviewState("initializeConnection")
      await this.flushPendingSessionRefresh("initializeConnection")
      this.recoverPendingPrompts()

      // Fetch providers, agents, skills, config, notifications, and session statuses in parallel
      await Promise.all([
        this.fetchAndSendProviders(),
        this.fetchAndSendAgents(),
        this.fetchAndSendSkills(),
        this.fetchAndSendCommands(),
        this.fetchAndSendConfig(),
        // this.fetchAndSendNotifications(),
        this.seedSessionStatusMap(),
      ])
      this.cachedGitRepo = await hasGit(this.client!, this.getWorkspaceDirectory())
      this.postMessage({ type: "gitStatus", repo: this.cachedGitRepo })
      this.sendNotificationSettings()
      this.sendTimelineSetting()
      this.postMessage({ type: "extensionDataReady" })

      if (this.cachedGitRepo) this.startStatsPolling()

      console.log("[TestAgent]  ✅ initializeConnection completed successfully")
    } catch (error) {
      console.error("[TestAgent]  ❌ Failed to initialize connection:", error)
      this.connectionState = "error"
      this.postMessage({
        type: "connectionState",
        state: "error",
        error: getErrorMessage(error) || "Failed to connect to CLI backend",
        ...(error instanceof ServerStartupError && {
          userMessage: error.userMessage,
          userDetails: error.userDetails,
        }),
      })
    }
  }

  private sessionToWebview(session: Session) {
    return sessionToWebview(session)
  }

  private async handleCreateSession(): Promise<void> {
    if (!this.client) {
      this.postMessage({
        type: "error",
        message: "Not connected to CLI backend",
      })
      return
    }

    try {
      const workspaceDir = this.getContextDirectory()
      const { data: session } = await this.client.session.create({ directory: workspaceDir }, { throwOnError: true })
      this.currentSession = session
      this.contextSessionID = session.id
      this.trackDirectory(session.id, workspaceDir)
      this.trackedSessionIds.add(session.id)

      // Notify webview of the new session
      this.postMessage({
        type: "sessionCreated",
        session: this.sessionToWebview(this.currentSession!),
      })
    } catch (error) {
      console.error("[TestAgent]  Failed to create session:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to create session",
      })
    }
  }

  /** Non-blocking: refresh session metadata + status for the webview after switching. */
  private refreshSessionDetails(sessionID: string, dir: string, signal?: AbortSignal): void {
    if (!this.client) return
    this.client.session
      .get({ sessionID, directory: dir })
      .then((r) => {
        if (r.data && !signal?.aborted) {
          this.currentSession = r.data
          this.contextSessionID = r.data.id
        }
      })
      .catch((e: unknown) => console.warn("[TestAgent]  getSession failed (non-critical):", e))
    this.postMessage({ type: "workspaceDirectoryChanged", directory: this.getWorkspaceDirectory(sessionID) })
    this.client.session
      .status({ directory: dir })
      .then((r) => {
        if (!r.data || signal?.aborted) return
        for (const [sid, info] of Object.entries(r.data) as [string, SessionStatus][]) {
          if (!this.trackedSessionIds.has(sid)) continue
          this.postMessage({
            type: "sessionStatus",
            sessionID: sid,
            status: info.type,
            ...(info.type === "retry" ? { attempt: info.attempt, message: info.message, next: info.next } : {}),
          })
        }
      })
      .catch((e: unknown) => console.error("[TestAgent]  Failed to fetch session statuses:", e))
  }

  private async handleLoadMessages(
    sessionID: string,
    options: { mode?: MessageLoadMode; before?: string; limit?: number } = {},
  ): Promise<void> {
    const mode = options.mode ?? "replace"
    if (mode !== "prepend") {
      this.trackedSessionIds.add(sessionID)
      this.focusSession(sessionID)
      this.contextSessionID = sessionID
    }
    if (!this.client) {
      this.postMessage({ type: "error", message: "Not connected to CLI backend", sessionID })
      return
    }
    const dir = this.getWorkspaceDirectory(sessionID)
    console.log("[TestAgent] loadMessages: request", {
      sessionID,
      dir,
      mode,
      before: options.before,
      limit: options.limit ?? MESSAGE_PAGE_LIMIT,
      tracked: this.trackedSessionIds.has(sessionID),
    })
    if (mode === "focus") {
      this.refreshSessionDetails(sessionID, dir)
      // Reconcile tail so SSE drops self-heal. Throttled to skip rapid tab-switching bursts.
      if (Date.now() - (this.lastReconciledAt.get(sessionID) ?? 0) < 1000) return
      await this.handleLoadMessages(sessionID, { mode: "reconcile", limit: options.limit ?? MESSAGE_PAGE_LIMIT })
      return
    }
    // Replace competes for the spinner and cancels earlier loads; prepend/reconcile run in parallel.
    const abort = mode === "replace" ? new AbortController() : undefined
    if (abort) {
      this.loadMessagesAbort?.abort()
      this.loadMessagesAbort = abort
      this.refreshSessionDetails(sessionID, dir, abort.signal)
    }
    try {
      const page = await fetchMessagePage(this.client, {
        sessionID,
        workspaceDir: dir,
        limit: options.limit ?? MESSAGE_PAGE_LIMIT,
        before: options.before,
        signal: abort?.signal,
      })
      if (abort?.signal.aborted) return
      // Drop results for a session deleted mid-fetch. Prepend/reconcile have
      // no abort controller, so this guard prevents ghost entries.
      if (!this.trackedSessionIds.has(sessionID)) return
      const messages = page.items.map((m) => ({
        ...m.info,
        parts: this.slimParts(m.parts),
        createdAt: new Date(m.info.time.created).toISOString(),
      }))
      for (const message of messages) {
        this.connectionService.recordMessageSessionId(message.id, message.sessionID)
      }
      // Authoritative snapshot: drop queued deltas. Prepend is older history
      // and must not clobber live deltas.
      if (mode === "replace" || mode === "reconcile") this.streams.drop(sessionID)
      if (mode === "reconcile") this.lastReconciledAt.set(sessionID, Date.now())
      this.postMessage({
        type: "messagesLoaded",
        sessionID,
        messages,
        mode,
        cursor: page.cursor,
        hasMore: Boolean(page.cursor),
      })
      // Recover any prompts missed while the webview was loading or during an SSE reconnection.
      this.recoverPendingPrompts()
    } catch (error) {
      if (abort?.signal.aborted) return
      console.error("[TestAgent]  Failed to load messages:", {
        sessionID,
        dir,
        mode,
        before: options.before,
        limit: options.limit ?? MESSAGE_PAGE_LIMIT,
        message: getErrorMessage(error),
        error,
      })
      this.postMessage({ type: "error", message: getErrorMessage(error) || "Failed to load messages", sessionID })
    }
  }

  /**
   * Handle syncing a child session (e.g. spawned by the task tool).
   * Tracks the session for SSE events and fetches its messages.
   */
  private async handleSyncSession(sessionID: string, parentSessionID?: string): Promise<void> {
    if (!this.client) return
    if (syncedChildSessions.has(sessionID)) return

    syncedChildSessions.add(sessionID)
    this.trackedSessionIds.add(sessionID)

    // Inherit the parent's worktree directory so permission responses use
    // the correct backend Instance. Without this, child sessions in Agent
    // Manager worktrees fall back to workspace root and fail to find the
    // pending permission request.
    if (!this.sessionDirectories.has(sessionID) && parentSessionID) {
      const dir = this.sessionDirectories.get(parentSessionID)
      if (dir) {
        this.sessionDirectories.set(sessionID, dir)
      }
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory(sessionID)
      const { data: messagesData } = await retry(() =>
        this.client!.session.messages({ sessionID, directory: workspaceDir }, { throwOnError: true }),
      )

      const messages = messagesData.map((m) => ({
        ...m.info,
        parts: this.slimParts(m.parts),
        createdAt: new Date(m.info.time.created).toISOString(),
      }))

      for (const message of messages) {
        this.connectionService.recordMessageSessionId(message.id, message.sessionID)
      }

      // Snapshot supersedes any queued deltas (see handleLoadMessages for the
      // snapshot-freshness assumption that governs drop() here).
      this.streams.drop(sessionID)
      this.postMessage({
        type: "messagesLoaded",
        sessionID,
        messages,
        mode: "replace",
        hasMore: false,
      })

      // Recover any prompts emitted by the child before we started tracking it.
      this.recoverPendingPrompts()
    } catch (err) {
      syncedChildSessions.delete(sessionID)
      console.error("[TestAgent]  Failed to sync child session:", err)
    }
  }

  /**
   * Build the context object used by the extracted session-refresh helpers.
   */
  private get sessionRefreshContext(): SessionRefreshContext {
    const client = this.client
    return {
      pendingSessionRefresh: this.pendingSessionRefresh,
      connectionState: this.connectionState,
      listSessions: client
        ? (dir: string) =>
            client.session.list({ directory: dir, roots: true }, { throwOnError: true }).then(({ data }) => data)
        : null,
      sessionDirectories: this.sessionDirectories,
      workspaceDirectory: this.getWorkspaceDirectory(),
      postMessage: (msg: unknown) => this.postMessage(msg),
    }
  }

  /**
   * Retry a deferred sessions refresh once the client is ready.
   */
  private async flushPendingSessionRefresh(reason: string): Promise<void> {
    if (!this.pendingSessionRefresh) return
    console.log("[TestAgent]  🔄 Flushing deferred sessions refresh", { reason })
    const ctx = this.sessionRefreshContext
    try {
      const resolved = await flushPendingSessionRefreshUtil(ctx)
      if (resolved) this.projectID = resolved
    } catch (error) {
      console.error("[TestAgent]  Failed to flush session refresh:", error)
    }
    this.pendingSessionRefresh = ctx.pendingSessionRefresh
  }

  /**
   * Handle loading all sessions.
   */
  private async handleLoadSessions(): Promise<void> {
    const ctx = this.sessionRefreshContext
    // testagent_change - debug logging
    console.log("[testagent] KiloProvider.handleLoadSessions called", {
      workspaceDirectory: ctx.workspaceDirectory,
      sessionDirectories: Object.fromEntries(ctx.sessionDirectories),
      hasClient: !!ctx.listSessions,
      connectionState: ctx.connectionState,
    })
    try {
      const resolved = await loadSessionsUtil(ctx)
      if (resolved) this.projectID = resolved
      // testagent_change - debug logging
      console.log("[testagent] KiloProvider.handleLoadSessions done", { resolved })
    } catch (error) {
      console.error("[TestAgent]  Failed to load sessions:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to load sessions",
      })
    }
    this.pendingSessionRefresh = ctx.pendingSessionRefresh
  }

  private async handleTerminalContext(requestId: string): Promise<void> {
    try {
      const output = await getTerminalContents(-1)
      this.postMessage({
        type: "terminalContextResult",
        requestId,
        content: output.content,
        truncated: output.truncated,
      })
    } catch (error) {
      console.error("[TestAgent] Failed to capture terminal context:", error)
      this.postMessage({
        type: "terminalContextError",
        requestId,
        error: getErrorMessage(error) || "Failed to capture terminal output",
      })
    }
  }

  /**
   * Handle deleting a session.
   */
  private async handleDeleteSession(sessionID: string): Promise<void> {
    if (!this.client) {
      this.postMessage({ type: "error", message: "Not connected to CLI backend" })
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory(sessionID)
      await this.client.session.delete({ sessionID, directory: workspaceDir }, { throwOnError: true })
      this.trackedSessionIds.delete(sessionID)
      this.streams.drop(sessionID)
      syncedChildSessions.delete(sessionID)
      this.sessionDirectories.delete(sessionID)
      this.lastReconciledAt.delete(sessionID)
      this.connectionService.pruneSession(sessionID)
      if (this.currentSession?.id === sessionID) {
        this.currentSession = null
        this.focusSession(undefined)
      }
      this.postMessage({ type: "sessionDeleted", sessionID })
    } catch (error) {
      console.error("[TestAgent]  Failed to delete session:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to delete session",
      })
    }
  }

  /**
   * Handle renaming a session.
   */
  private async handleRenameSession(sessionID: string, title: string): Promise<void> {
    if (!this.client) {
      this.postMessage({ type: "error", message: "Not connected to CLI backend" })
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory(sessionID)
      const { data: updated } = await this.client.session.update(
        { sessionID, directory: workspaceDir, title },
        { throwOnError: true },
      )
      if (this.currentSession?.id === sessionID) {
        this.currentSession = updated
      }
      this.postMessage({ type: "sessionUpdated", session: this.sessionToWebview(updated) })
    } catch (error) {
      console.error("[TestAgent]  Failed to rename session:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to rename session",
      })
    }
  }

  /** Fetch providers and send to webview. Coalesced: at most one in-flight + one queued. */
  private async fetchAndSendProviders(): Promise<void> {
    const next = ++this.providersGeneration
    if (this.providersRefresh) {
      this.providersQueued = true
      await this.providersRefresh
      return
    }
    const task = (async () => {
      let generation = next
      while (true) {
        this.providersQueued = false
        const client = this.client
        if (!client) {
          if (this.cachedProvidersMessage && generation === this.providersGeneration)
            this.postMessage(this.cachedProvidersMessage)
          return
        }
        try {
          const { response, authMethods, authStates } = await fetchProviderData(client, this.getWorkspaceDirectory())
          if (generation !== this.providersGeneration || client !== this.client) {
            if (!this.providersQueued) return
            generation = this.providersGeneration
            continue
          }
          const settings = vscode.workspace.getConfiguration("testagent.new.model")
          const message = {
            type: "providersLoaded",
            providers: indexProvidersById(response.all),
            connected: response.connected,
            defaults: response.default,
            defaultSelection: computeDefaultSelection(
              this.cachedConfigMessage as { config?: { model?: string } } | null,
              settings.get<string>("providerID", ""),
              settings.get<string>("modelID", ""),
            ),
            authMethods,
            authStates,
          }
          this.cachedProvidersMessage = message
          this.postMessage(message)
        } catch (error) {
          if (generation !== this.providersGeneration) {
            if (!this.providersQueued) return
            generation = this.providersGeneration
            continue
          }
          console.error("[TestAgent]  Failed to fetch providers:", error)
        }
        if (!this.providersQueued) return
        generation = this.providersGeneration
      }
    })()
    const done = task.finally(() => {
      if (this.providersRefresh === done) this.providersRefresh = null
    })
    this.providersRefresh = done
    await done
  }

  private async handleProviderAction(msg: Record<string, unknown>): Promise<void> {
    const rid = typeof msg.requestId === "string" ? msg.requestId : ""
    const pid = typeof msg.providerID === "string" ? msg.providerID : ""
    if (!rid || !pid) return
    if (!this.client) {
      const action =
        msg.type === "disconnectProvider"
          ? "disconnect"
          : msg.type === "authorizeProviderOAuth"
            ? "authorize"
            : "connect"
      this.postMessage({
        type: "providerActionError",
        requestId: rid,
        providerID: pid,
        action,
        message: "Not connected to CLI backend",
      })
      return
    }
    const ctx = buildActionContext(
      this.client,
      (m) => this.postMessage(m),
      getErrorMessage,
      this.getWorkspaceDirectory(),
      () => this.fetchAndSendProviders(),
    )
    const set = (m: unknown) => {
      this.cachedConfigMessage = m
    }
    const method = typeof msg.method === "number" ? msg.method : 0
    const key = typeof msg.apiKey === "string" ? msg.apiKey : undefined
    const keyChanged = msg.apiKeyChanged === true
    const code = typeof msg.code === "string" ? msg.code : undefined
    const config = msg.config && typeof msg.config === "object" ? (msg.config as Record<string, unknown>) : undefined
    if (msg.type === "connectProvider" && key) return connectProviderAction(ctx, rid, pid, key)
    if (msg.type === "authorizeProviderOAuth") return authorizeOAuthAction(ctx, rid, pid, method)
    if (msg.type === "completeProviderOAuth") return completeOAuthAction(ctx, rid, pid, method, code)
    if (msg.type === "disconnectProvider") return disconnectProviderAction(ctx, rid, pid, this.cachedConfigMessage, set)
    if (msg.type === "saveCustomProvider" && config)
      return saveCustomProviderAction(ctx, rid, pid, config, key, keyChanged, this.cachedConfigMessage, set)
  }

  private async handleFetchCustomProviderModels(msg: Record<string, unknown>): Promise<void> {
    const rid = typeof msg.requestId === "string" ? msg.requestId : ""
    const url = typeof msg.baseURL === "string" ? msg.baseURL : ""
    if (!rid || !url) return
    const key = typeof msg.apiKey === "string" ? msg.apiKey : undefined
    const headers = msg.headers && typeof msg.headers === "object" ? (msg.headers as Record<string, string>) : undefined
    try {
      const models = await fetchOpenAIModels({ baseURL: url, apiKey: key, headers })
      // this.postMessage({ type: "customProviderModelsFetched", requestId: rid, models })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch models"
      const auth = err instanceof FetchModelsError && err.auth
      // this.postMessage({ type: "customProviderModelsFetched", requestId: rid, error: message, auth,url})
    }
  }

  /**
   * Fetch agents (modes) from the backend and send to webview.
   */
  private async fetchAndSendAgents(): Promise<void> {
    if (!this.client) {
      if (this.cachedAgentsMessage) {
        this.postMessage(this.cachedAgentsMessage)
      }
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory()
      const { data: agents } = await retry(() =>
        this.client!.app.agents({ directory: workspaceDir }, { throwOnError: true }),
      )

      const { visible, defaultAgent } = filterVisibleAgents(agents)

      const message = {
        type: "agentsLoaded",
        agents: visible.map(mapAgent),
        allAgents: agents.map(mapAgent),
        defaultAgent,
      }
      this.cachedAgentsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch agents:", error)
    }
  }

  /**
   * Reload skills from disk (for external plugins that install skills)
   * Public API that can be called via VS Code commands
   */
  public async reloadSkills(): Promise<void> {
    console.log("[TestAgent] Reloading skills...")

    // Clear frontend cache first
    this.cachedSkillsMessage = null
    this.clearCommandsCache() // testagent_change - also clear commands cache

    // testagent_change start - dispose instance to clear all caches including skills
    if (this.client) {
      try {
        const dir = this.getWorkspaceDirectory()
        // 使用已有的 instance.dispose API 来清除所有缓存（包括 skills）
        await this.client.instance.dispose({ directory: dir })
        console.log("[TestAgent] Backend instance cache cleared")

        // 等待足够长的时间确保后端完全重建状态
        // 这个延迟很重要，因为 InstanceState 需要时间重新初始化
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (error) {
        console.warn("[TestAgent] Backend cache clear failed (non-critical):", error)
      }
    }
    // testagent_change end

    // testagent_change start - fetch skills first, then commands (commands depend on skills)
    await this.fetchAndSendSkills()
    await this.fetchAndSendCommands()
    // testagent_change end
     vscode.window.showInformationMessage("skills已重新加载")
    console.log("[TestAgent] Skills and commands reloaded successfully")
  }

  /**
   * Reload MCP servers from config (for external plugins that modify config)
   * Public API that can be called via VS Code commands
   * testagent_change
   *
   * Uses the backend's dedicated /mcp/reload endpoint to reload only MCP servers
   * without affecting other services (Sessions, Plugins, Skills, etc.)
   */
  public async reloadMcp(): Promise<void> {
    console.log("[TestAgent] Reloading MCP servers from config...")

    // Clear frontend cache
    this.cachedMcpStatusMessage = null
    this.cachedConfigMessage = null
    this.cachedAgentsMessage = null

    if (!this.client || this.connectionState !== "connected") {
      console.warn("[TestAgent] Cannot reload MCP: not connected to CLI backend")
      vscode.window.showWarningMessage("无法重新加载 MCP 服务器：未连接到后端服务")
      return
    }

    if (this.getBusySessionCount() > 0) {
      vscode.window.showWarningMessage("无法在任务运行期间重新加载 MCP 服务器")
      return
    }

    try {
      // Get the underlying SDK client to access its request method
      const sdkClient = (this.client as any).client
      if (!sdkClient || typeof sdkClient.post !== "function") {
        throw new Error("SDK client not available or invalid")
      }

      // Call the backend /mcp/reload endpoint using SDK's post method
      // This uses the SDK's built-in authentication, avoiding 401 errors
      const response = await sdkClient.post({
        url: "/mcp/reload",
        body: {},
      })

      if (response.error) {
        throw new Error(response.error.message || String(response.error))
      }

      const result = response.data as { success?: boolean }
      if (!result?.success) {
        throw new Error("Backend returned success: false")
      }

      console.log("[TestAgent] Backend MCP reload completed")

      // Invalidate backend config cache to ensure fresh config is loaded
      // This is critical for picking up changes from both global and project config files
      const dir = this.getWorkspaceDirectory()
      console.log("[TestAgent] Invalidating backend config cache for directory:", dir)

      // Invalidate global config cache
      await this.client.global.config.update({ config: {} }).catch((e: unknown) => {
        console.warn("[TestAgent] global.config.update after MCP reload failed:", e)
      })

      // Dispose instance to force rebuild from fresh config
      await this.client.instance.dispose({ directory: dir }).catch((e: unknown) => {
        console.warn("[TestAgent] instance.dispose after MCP reload failed:", e)
      })

      // Wait for backend to rebuild state
      console.log("[TestAgent] Waiting for backend to rebuild state...")
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Refresh all relevant data in UI
      console.log("[TestAgent] Fetching fresh data from backend...")
      await Promise.all([this.fetchAndSendMcpStatus(), this.fetchAndSendConfig(true), this.fetchAndSendAgents()])

      console.log("[TestAgent] MCP servers reloaded successfully")
      vscode.window.showInformationMessage("MCP 服务器已重新加载")
    } catch (error) {
      console.error("[TestAgent] Failed to reload MCP servers:", error)
      const message = error instanceof Error ? error.message : String(error)
      vscode.window.showErrorMessage(`重新加载 MCP 服务器失败: ${message}`)

      // Fallback: try to refresh UI anyway
      try {
        this.cachedConfigMessage = null
        this.cachedAgentsMessage = null
        await Promise.all([this.fetchAndSendMcpStatus(), this.fetchAndSendConfig(true), this.fetchAndSendAgents()])
      } catch (fetchError) {
        console.error("[TestAgent] Failed to fetch data after reload error:", fetchError)
      }
    }
  }

  private async fetchAndSendSkills(): Promise<void> {
    if (!this.client) {
      if (this.cachedSkillsMessage) {
        this.postMessage(this.cachedSkillsMessage)
      }
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory()
      const { data: skills } = await retry(() =>
        this.client!.app.skills({ directory: workspaceDir }, { throwOnError: true }),
      )

      const message = {
        type: "skillsLoaded",
        skills,
      }
      this.cachedSkillsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch skills:", error)
    }
  }

  private clearCommandsCache(): void {
    this.cachedCommandsMessage = null
    clearCommandsCache()
  }

  private async fetchAndSendCommands(): Promise<void> {
    if (!this.client) {
      if (this.cachedCommandsMessage) {
        this.postMessage(this.cachedCommandsMessage)
      }
      return
    }

    try {
      const dir = this.getWorkspaceDirectory()
      const message = await loadCommands(this.client, dir)

      this.cachedCommandsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch commands:", error)
    }
  }

  private async fetchCliSkills(): Promise<Array<{ name: string; location: string }> | undefined> {
    if (!this.client) return undefined
    try {
      const dir = this.getWorkspaceDirectory()
      const { data } = await retry(() => this.client!.app.skills({ directory: dir }, { throwOnError: true }))
      return data
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch CLI skills for marketplace:", error)
      return undefined
    }
  }

  /**
   * Remove a skill from disk, then refresh the CLI-backed skill/command state.
   * Returns true on success, false on failure.
   * On failure, re-fetches skills so the webview reverts to the authoritative state.
   */
  private async removeSkill(location: string): Promise<boolean> {
    if (!this.client) return false

    const refresh = async () => {
      this.cachedSkillsMessage = null
      this.clearCommandsCache()
      await Promise.all([this.fetchAndSendSkills(), this.fetchAndSendCommands()])
    }

    try {
      const dir = this.getWorkspaceDirectory()
      const file = path.resolve(location)
      const root = path.parse(file).root
      const base = path.dirname(file)

      if (path.basename(file) !== "SKILL.md" || base === root) {
        console.error("[TestAgent] Invalid skill location:", location)
        await refresh()
        return false
      }

      if (!isManagedSkillLocation(location)) {
        console.error("[TestAgent] Refusing to remove skill outside managed directories:", location)
        await refresh()
        return false
      }

      const stat = await fs.promises.stat(file)
      if (!stat.isFile()) {
        console.error("[TestAgent] Skill location is not a file:", location)
        await refresh()
        return false
      }

      await fs.promises.rm(base, { recursive: true, force: true })
      await this.client.instance.dispose({ directory: dir }).catch((error: unknown) => {
        console.warn("[TestAgent] instance.dispose after skill removal failed:", error)
      })
    } catch (error) {
      console.error("[TestAgent] Failed to remove skill:", error)
      await refresh()
      return false
    }

    await refresh()
    return true
  }

  private async removePlugin(location: string): Promise<boolean> {
    if (!this.client) return false

    const refresh = async () => {
      this.cachedConfigMessage = null
      this.cachedSkillsMessage = null
      this.clearCommandsCache()
      await Promise.all([
        this.fetchAndSendConfig(),
        this.fetchAndSendSkills(),
        this.fetchAndSendCommands(),
        this.fetchAndSendAgents(),
        this.fetchAndSendMcpStatus(),
      ])
    }

    try {
      const dir = this.getWorkspaceDirectory()
      const file = path.resolve(location.startsWith("file://") ? fileURLToPath(location) : location)

      if (!isManagedPluginLocation(file)) {
        console.error("[TestAgent] Refusing to remove plugin outside managed directories:", location)
        await refresh()
        return false
      }

      const stat = await fs.promises.stat(file)
      if (!stat.isFile()) {
        console.error("[TestAgent] Plugin location is not a file:", location)
        await refresh()
        return false
      }

      await fs.promises.rm(file, { force: true })
      await this.client.instance.dispose({ directory: dir }).catch((error: unknown) => {
        console.warn("[TestAgent] instance.dispose after plugin removal failed:", error)
      })
    } catch (error) {
      console.error("[TestAgent] Failed to remove plugin:", error)
      await refresh()
      return false
    }

    await refresh()
    return true
  }

  /**
   * Remove a custom mode via the CLI backend (deletes from disk + refreshes state).
   * The webview optimistically removes the mode from its list before this runs.
   * On failure, re-fetches agents so the webview reverts to the authoritative state.
   */
  private async handleRemoveMode(name: string): Promise<void> {
    console.log("[TestAgent]  handleRemoveMode called for:", name) // testagent_change
    if (!this.client) {
      console.log("[TestAgent]  handleRemoveMode: no client") // testagent_change
      return
    }

    // 1. Try CLI removal (handles .md files and legacy .kilocodemodes)
    try {
      const dir = this.getWorkspaceDirectory()
      console.log("[TestAgent]  handleRemoveMode: trying CLI removal, dir:", dir) // testagent_change
      // opencode 没有这个api
      const result = await this.client.kilocode.removeAgent({ name, directory: dir })
      console.log("[TestAgent]  handleRemoveMode: CLI result:", result) // testagent_change
      // testagent_change start: Check if API returned HTML (404 fallback) instead of valid response
      if (!result.error && typeof result.data === "boolean" && result.data === true) {
        // testagent_change end
        this.cachedAgentsMessage = null
        await this.fetchAndSendAgents()
        console.log("[TestAgent]  handleRemoveMode: CLI removal successful") // testagent_change
        return
      }
      // testagent_change start: If data is HTML string, API doesn't exist
      if (typeof result.data === "string") {
        console.log("[TestAgent]  handleRemoveMode: CLI API returned HTML, falling back to config file") // testagent_change
      }
      // testagent_change end
    } catch (err) {
      // CLI removal failed — agent may be in kilo.json instead
      console.log("[TestAgent]  handleRemoveMode: CLI removal failed:", err) // testagent_change
    }

    // 2. Try removing from kilo.json (handles marketplace-installed modes)
    console.log("[TestAgent]  handleRemoveMode: trying config file removal") // testagent_change
    const stub = { id: name, type: "mode" as const, name, description: "", content: "" }
    const removed = await this.removeMarketplaceItemFromAllScopes(stub)
    console.log("[TestAgent]  handleRemoveMode: config file removal result:", removed) // testagent_change
    if (!removed) {
      console.error("[TestAgent]  Failed to remove mode:", name)
    }
  }

  private async handleRemoveMcp(name: string): Promise<void> {
    if (this.getBusySessionCount() > 0) {
      vscode.window.showWarningMessage("无法在任务运行期间删除 MCP 服务器")
      return
    }

    // Remove from legacy files first so that the subsequent invalidation
    // causes the CLI to re-read config without the legacy entry.
    await this.removeLegacyMcp(name)

    const stub = { id: name, type: "mcp" as const, name, description: "", url: "", content: "" }
    const removed = await this.removeMarketplaceItemFromAllScopes(stub)
    if (!removed) {
      console.error("[TestAgent]  Failed to remove MCP server:", name)
    }
  }

  /**
   * Remove an MCP server from legacy config files (.kilo/mcp.json, .kilocode/mcp.json,
   * and the VS Code global storage mcp_settings.json). These files are read by the
   * CLI-side McpMigrator and merged into config at the lowest precedence level.
   * Returns true if the entry was found and removed from at least one file.
   */
  private async removeLegacyMcp(name: string): Promise<boolean> {
    const workspace = this.getProjectDirectory(this.currentSession?.id)
    const files: vscode.Uri[] = []

    // Project-level legacy files
    if (workspace) {
      files.push(vscode.Uri.file(path.join(workspace, ".kilo", "mcp.json")))
      files.push(vscode.Uri.file(path.join(workspace, ".kilocode", "mcp.json")))
    }

    // Global legacy file (VS Code extension global storage)
    const storage = this.extensionContext?.globalStorageUri
    if (storage) {
      files.push(vscode.Uri.joinPath(storage, "settings", "mcp_settings.json"))
    }

    let removed = false
    for (const uri of files) {
      const bytes = await vscode.workspace.fs.readFile(uri).then(
        (b) => b,
        () => null,
      )
      if (!bytes) continue

      try {
        const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>
        const servers = parsed.mcpServers as Record<string, unknown> | undefined
        if (!servers?.[name]) continue

        delete servers[name]
        const content = Buffer.from(JSON.stringify(parsed, null, 2), "utf8")
        await vscode.workspace.fs.writeFile(uri, content)
        removed = true
      } catch (err) {
        console.warn("[TestAgent]  Failed to remove legacy MCP from", uri.fsPath, err)
      }
    }

    return removed
  }

  private async fetchAndSendMcpStatus(): Promise<void> {
    if (!this.client) {
      if (this.cachedMcpStatusMessage) {
        this.postMessage(this.cachedMcpStatusMessage)
      }
      return
    }

    try {
      const directory = this.getWorkspaceDirectory()
      const { data } = await retry(() => this.client!.mcp.status({ directory }))
      if (data) {
        const message = { type: "mcpStatusLoaded", status: data }
        this.cachedMcpStatusMessage = message
        this.postMessage(message)
      }
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch MCP status:", error)
    }
  }

  private async handleConnectMcp(name: string): Promise<void> {
    if (!this.client) return
    if (this.getBusySessionCount() > 0) {
      vscode.window.showWarningMessage("无法在任务运行期间连接 MCP 服务器")
      return
    }
    try {
      const directory = this.getWorkspaceDirectory()
      await this.client.mcp.connect({ name, directory })
      await this.fetchAndSendMcpStatus()
    } catch (error) {
      console.error("[TestAgent]  Failed to connect MCP:", name, error)
      await this.fetchAndSendMcpStatus()
    }
  }

  private async handleDisconnectMcp(name: string): Promise<void> {
    if (!this.client) return
    if (this.getBusySessionCount() > 0) {
      vscode.window.showWarningMessage("无法在任务运行期间断开 MCP 服务器")
      return
    }
    try {
      const directory = this.getWorkspaceDirectory()
      await this.client.mcp.disconnect({ name, directory })
      await this.fetchAndSendMcpStatus()
    } catch (error) {
      console.error("[TestAgent]  Failed to disconnect MCP:", name, error)
      await this.fetchAndSendMcpStatus()
    }
  }

  /**
   * Remove a marketplace item from a single scope and invalidate CLI caches.
   */
  private async removeMarketplaceItem(item: MarketplaceItem, scope: "project" | "global"): Promise<RemoveResult> {
    const workspace = this.getProjectDirectory(this.currentSession?.id)
    const result = await this.getMarketplace().remove(item, scope, workspace)
    if (result.success) {
      await this.invalidateAfterMarketplaceChange(scope)
    }
    return result
  }

  /**
   * Remove a marketplace item from both project and global scopes.
   * mp.remove returns success even when the entry doesn't exist (no-op),
   * so we must attempt both scopes to cover dual-scope installations.
   * Returns true if at least one scope removal succeeded.
   */
  private async removeMarketplaceItemFromAllScopes(item: MarketplaceItem): Promise<boolean> {
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: starting for", item.id) // testagent_change
    const workspace = this.getProjectDirectory(this.currentSession?.id)
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: workspace =", workspace) // testagent_change
    const mp = this.getMarketplace()
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: calling mp.remove for project scope") // testagent_change
    const project = await mp.remove(item, "project", workspace)
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: project result =", project) // testagent_change
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: calling mp.remove for global scope") // testagent_change
    const global = await mp.remove(item, "global", workspace)
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: global result =", global) // testagent_change

    if (project.success || global.success) {
      const scope = global.success ? "global" : "project"
      console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: invalidating scope =", scope) // testagent_change
      await this.invalidateAfterMarketplaceChange(scope)
      console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: done, returning true") // testagent_change
      return true
    }
    console.log("[TestAgent]  removeMarketplaceItemFromAllScopes: done, returning false") // testagent_change
    return false
  }

  private async refreshGlobalConfigCache(): Promise<void> {
    const raw = (
      this.client as unknown as {
        client?: {
          patch: (input: { url: string; body: Record<string, unknown> }) => Promise<{ error?: unknown }>
        }
      } | null
    )?.client

    if (!raw || typeof raw.patch !== "function") {
      throw new Error("SDK raw client patch method is not available")
    }

    const res = await raw.patch({ url: "/global/config", body: {} })
    if (res.error) throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error))
  }

  /**
   * Invalidate CLI caches and refresh the webview after a marketplace install/remove.
   *
   * For global scope: uses global.config.update with the freshly-written config file
   * contents rather than global.dispose. This goes through Config.updateGlobal() which
   * calls Config.global.reset() to invalidate the lazy-cached global config, ensuring
   * the newly installed/removed MCP entry is visible on the next config.get call.
   * (global.dispose alone is not sufficient on older CLI versions that lack the
   * Config.global.reset() call in the dispose handler.)
   *
   * For project scope: instance.dispose is sufficient because the per-instance
   * Config.state is cleared and re-reads all files (including global) on next access.
   */
  private async invalidateAfterMarketplaceChange(scope: "project" | "global"): Promise<void> {
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: starting, scope =", scope) // testagent_change
    if (!this.client) return

    const dir = this.getWorkspaceDirectory()

    if (scope === "global") {
      // testagent_change start: Use global.config.update({}) to trigger Config.updateGlobal()
      // which now always calls invalidate() to clear the cachedGlobal cache (Duration.infinity TTL)
      // This is critical because Config.Service has a cachedGlobal that won't be cleared by instance.dispose() alone.
      console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: invalidating global config cache") // testagent_change
      await this.refreshGlobalConfigCache().catch((e: unknown) => {
        console.warn("[TestAgent] global.config.update after marketplace change failed:", e)
      })
      console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: global config cache invalidated") // testagent_change
      // testagent_change end
    }

    // Always dispose the per-project instance so it rebuilds state from
    // the (possibly updated) global + project config on the next request.
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: calling instance.dispose, dir =", dir) // testagent_change
    await this.client.instance.dispose({ directory: dir }).catch((e: unknown) => {
      console.warn("[TestAgent] instance.dispose() after marketplace change failed:", e)
    })
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: instance.dispose complete") // testagent_change

    // Clear cached messages and wait a bit for backend to rebuild state
    this.cachedAgentsMessage = null
    this.cachedConfigMessage = null

    // testagent_change start: Add delay to ensure backend has time to rebuild state
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: waiting 200ms for backend to rebuild state...") // testagent_change
    await new Promise((resolve) => setTimeout(resolve, 200))
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: wait complete") // testagent_change
    // testagent_change end

    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: fetching fresh data") // testagent_change
    await Promise.all([this.fetchAndSendAgents(), this.fetchAndSendConfig()])
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: complete") // testagent_change

    // testagent_change start - Broadcast agents change to other KiloProvider instances
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: broadcasting agents change") // testagent_change
    this.connectionService.notifyAgentsChanged()
    console.log("[TestAgent]  🔄 invalidateAfterMarketplaceChange: broadcast complete") // testagent_change
    // testagent_change end
  }

  /**
   * Fetch backend config and send to webview.
   */
  private async fetchAndSendConfig(refresh = false): Promise<void> {
    console.log(
      "[TestAgent]  📋 fetchAndSendConfig called, connectionState:",
      this.connectionState,
      "refresh:",
      refresh,
    ) // testagent_change
    if (!this.client || this.connectionState !== "connected") {
      console.log("[TestAgent]  ⚠️ Not connected, cachedConfigMessage:", this.cachedConfigMessage) // testagent_change
      if (this.cachedConfigMessage) {
        this.postMessage(this.cachedConfigMessage)
      }
      return
    }

    // Skip if handleUpdateConfig is in flight — sending a configLoaded now
    // would race with the write and potentially overwrite optimistic webview state.
    if (this.pending > 0) {
      console.log("[TestAgent]  ⏳ Skipping config fetch, pending operations:", this.pending) // testagent_change
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory()
      console.log("[TestAgent]  🔍 Fetching config for directory:", workspaceDir) // testagent_change
      const { data: config } = await retry(() =>
        this.client!.config.get({ directory: workspaceDir }, { throwOnError: true }),
      )

      console.log("[TestAgent]  ✅ Config fetched successfully, keys:", Object.keys(config || {}).length) // testagent_change
      const message: { type: "configLoaded"; config: unknown; refresh?: boolean } = {
        type: "configLoaded",
        config,
      }
      if (refresh) message.refresh = true
      this.cachedConfigMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch config:", error)
    }
  }

  /** Fetch global-only config (no project/managed layers) for settings export. */
  private async fetchAndSendGlobalConfig(): Promise<void> {
    if (!this.client || this.connectionState !== "connected") return
    try {
      const { data: config } = await this.client.global.config.get({ throwOnError: true })
      this.postMessage({ type: "globalConfigLoaded", config })
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch global config:", error)
    }
  }

  /**
   * Seed sessionStatusMap with current session statuses on connect.
   * Without this, the Settings panel (which has no tracked sessions) would see
   * busyCount() = 0 for sessions that were already running before it opened.
   *
   * @param reconcile When true, reset locally-busy sessions absent from the
   *   server response to idle (crash recovery). Set to false on SSE reconnects
   *   to avoid a race where a brief HTTP fetch gap causes the spinner to vanish.
   */
  private async seedSessionStatusMap(reconcile = true): Promise<void> {
    if (!this.client || this.connectionState !== "connected") return
    const dir = this.getWorkspaceDirectory()
    await seedSessionStatuses(this.client, dir, this.sessionStatusMap, (msg) => this.postMessage(msg), reconcile)
  }

  // testagent_change start - on SSE reconnect, the local session status map may
  // be stale because session.status/idle events can be lost when the stream
  // drops during a heartbeat/reconnect window. Force-reconcile against the
  // backend so the webview stops showing a stuck busy state / running timer.
  private async reconcileSessionStatusesOnReconnect(): Promise<void> {
    if (!this.client || this.connectionState !== "connected") return
    const dir = this.getWorkspaceDirectory()
    try {
      const result = await this.client.session.status({ directory: dir })
      if (!result.data) return
      const active = result.data
      const changed: string[] = []
      for (const [sid, info] of Object.entries(active)) {
        const prev = this.sessionStatusMap.get(sid)
        if (prev !== info.type) {
          this.sessionStatusMap.set(sid, info.type)
          changed.push(sid)
        }
      }
      for (const sid of changed) {
        this.postMessage({ type: "sessionStatus", sessionID: sid, status: this.sessionStatusMap.get(sid)! })
      }
      for (const [sid, status] of this.sessionStatusMap) {
        if (status !== "idle" && !active[sid]) {
          this.sessionStatusMap.set(sid, "idle")
          this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
        }
      }
    } catch (error) {
      console.error("[TestAgent]  Failed to reconcile session statuses on reconnect:", error)
    }
  }
  // testagent_change end

  /**
   * Fetch the latest merged config and push it as configUpdated.
   * Called when global.config.updated SSE fires (config changed without a full dispose).
   */
  private async fetchAndSendConfigUpdated(): Promise<void> {
    if (!this.client || this.connectionState !== "connected") return
    try {
      const dir = this.getWorkspaceDirectory()
      const { data: config } = await retry(() => this.client!.config.get({ directory: dir }, { throwOnError: true }))
      this.cachedConfigMessage = { type: "configLoaded", config }
      this.postMessage({ type: "configUpdated", config })
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch config after update:", error)
    }
  }

  /**
   * Fetch config warnings from the server and display a single consolidated
   * VS Code warning with a "Show Details" action button.
   * Only shown once per provider lifecycle (flag resets on dispose/re-create, not on SSE reconnect).
   */
  private async checkConfigWarnings(from: string): Promise<void> {
    if (this.configWarningsShown) {
      console.log("[TestAgent]  config warnings already shown", { from })
      return
    }
    if (!this.client) {
      console.log("[TestAgent]  config warnings skipped (no client)", { from })
      return
    }
    try {
      const dir = this.getWorkspaceDirectory()
      console.log("[TestAgent]  checking config warnings", { from, dir })
      const result = await this.client.config.warnings({ directory: dir })
      console.log("[TestAgent]  raw result:", JSON.stringify(result).substring(0, 500)) // testagent_change - debug raw result (truncated)
      console.log("[TestAgent]  result.data type:", typeof result?.data, "isArray:", Array.isArray(result?.data)) // testagent_change - debug type

      // testagent_change start - ensure list is always an array
      let list = result?.data ?? []
      if (!Array.isArray(list)) {
        console.warn("[TestAgent]  result.data is not an array, converting:", typeof list)
        list = []
      }
      // testagent_change end

      console.log("[TestAgent]  config warnings fetched", { from, count: list.length })
      if (list.length === 0) return
      this.configWarningsShown = true

      // testagent_change start - limit warnings to prevent overwhelming the output
      const MAX_WARNINGS = 100
      const displayList = list.length > MAX_WARNINGS ? list.slice(0, MAX_WARNINGS) : list
      const truncated = list.length > MAX_WARNINGS
      // testagent_change end

      const first = list[0]!
      const summary = list.length === 1 ? first.message : `${first.message} (and ${list.length - 1} more)`
      console.warn("[TestAgent]  showing config warnings", { from, count: list.length, path: first.path })

      const action = await vscode.window.showWarningMessage(`Config: ${summary}`, "Show Details")
      console.log("[TestAgent]  user action:", JSON.stringify(action)) // testagent_change - debug exact value
      if (action === "Show Details") {
        console.log(
          "[TestAgent]  creating output channel with",
          displayList.length,
          "warnings (total:",
          list.length,
          ")",
        ) // testagent_change - debug
        console.log("[TestAgent]  displayList is array?", Array.isArray(displayList), "sample:", displayList[0]) // testagent_change - debug
        try {
          // testagent_change start - safe array handling
          if (!Array.isArray(displayList)) {
            console.error("[TestAgent]  displayList is not an array at show time:", typeof displayList, displayList)
            vscode.window.showErrorMessage("Failed to display config warnings: invalid data format")
            return
          }
          // testagent_change end

          const lines = displayList.map((w) => {
            const base = `${w.path}\n  ${w.message}`
            return w.detail ? `${base}\n  ${w.detail}` : base
          })

          // testagent_change start - add truncation notice
          if (truncated) {
            lines.push(`\n... and ${list.length - MAX_WARNINGS} more warnings (showing first ${MAX_WARNINGS})`)
          }
          // testagent_change end

          const channel = vscode.window.createOutputChannel("Kilo Config Warnings")
          channel.clear()
          channel.appendLine(lines.join("\n\n"))
          console.log("[TestAgent]  showing output channel") // testagent_change - debug
          channel.show(true) // testagent_change - preserveFocus=true to ensure visibility
          console.log("[TestAgent]  output channel shown") // testagent_change - debug
        } catch (channelErr) {
          console.error("[TestAgent]  failed to show output channel:", channelErr) // testagent_change
        }
      } else {
        console.log("[TestAgent]  user dismissed warning or action was:", action) // testagent_change
      }
    } catch (err) {
      console.warn("[TestAgent]  checkConfigWarnings failed:", { from, err })
    }
  }

  /**
   * Fetch Kilo news/notifications and send to webview.
   * Uses the cached message pattern so the webview gets data immediately on refresh.
   */
  private async fetchAndSendNotifications(): Promise<void> {
    if (!this.client) {
      if (this.cachedNotificationsMessage) {
        // Merge the latest dismissed IDs from globalState into the cached
        // message so that dismissals persisted while offline are honoured.
        const persisted = this.extensionContext?.globalState.get<string[]>("kilo.dismissedNotificationIds", []) ?? []
        if (persisted.length > 0) {
          const cached = this.cachedNotificationsMessage as {
            type: string
            notifications: unknown[]
            dismissedIds: string[]
          }
          const merged = Array.from(new Set([...cached.dismissedIds, ...persisted]))
          this.cachedNotificationsMessage = { ...cached, dismissedIds: merged }
        }
        this.postMessage(this.cachedNotificationsMessage)
      }
      return
    }

    try {
      // testagent_change start - disable notifications API (not available in testagent backend)
      // const { data: all } = await retry(() => this.client!.kilo.notifications(undefined, { throwOnError: true }))
      // // testagent_change start: Guard against non-array response (e.g. HTML from 404 fallback)
      // if (!Array.isArray(all)) {
      //   console.warn("[TestAgent]  notifications API returned non-array, skipping:", typeof all)
      //   return
      // }
      // // testagent_change end
      // const notifications = all.filter((n) => !n.showIn || n.showIn.includes("extension"))
      console.log("[TestAgent]  📢 Skipping notifications fetch (not available)")
      const notifications: any[] = []
      // testagent_change end
      const existing = this.extensionContext?.globalState.get<string[]>("kilo.dismissedNotificationIds", []) ?? []
      const active = new Set(notifications.map((n) => n.id))
      // Only prune stale dismissed IDs when we have a non-empty notification
      // list. An empty list may mean the API returned nothing due to being
      // unauthenticated (e.g. right after logout), not that all notifications
      // are gone — pruning in that case would wipe the persisted dismissals.
      const dismissedIds = notifications.length > 0 ? existing.filter((id) => active.has(id)) : existing
      if (dismissedIds.length !== existing.length) {
        await this.extensionContext?.globalState.update("kilo.dismissedNotificationIds", dismissedIds)
      }
      const message = { type: "notificationsLoaded", notifications, dismissedIds }
      this.cachedNotificationsMessage = message
      this.postMessage(message)
    } catch (error) {
      console.error("[TestAgent]  Failed to fetch notifications:", error)
    }
  }

  // Cloud session methods extracted to kilo-provider/handlers/cloud-session.ts

  /**
   * Persist a dismissed notification ID in globalState and push updated lists to webview.
   */
  private async handleDismissNotification(notificationId: string): Promise<void> {
    if (!this.extensionContext) return
    const existing = this.extensionContext.globalState.get<string[]>("kilo.dismissedNotificationIds", [])
    if (!existing.includes(notificationId)) {
      await this.extensionContext.globalState.update("kilo.dismissedNotificationIds", [...existing, notificationId])
    }
    // Update the cached message so the dismiss persists even if
    // fetchAndSendNotifications() fails (e.g. no client / API error).
    if (this.cachedNotificationsMessage) {
      const cached = this.cachedNotificationsMessage as {
        type: string
        notifications: unknown[]
        dismissedIds: string[]
      }
      if (!cached.dismissedIds.includes(notificationId)) {
        this.cachedNotificationsMessage = {
          ...cached,
          dismissedIds: [...cached.dismissedIds, notificationId],
        }
      }
    }
    // await this.fetchAndSendNotifications()
    this.connectionService.notifyNotificationDismissed(notificationId)
  }

  /**
   * Read notification/sound settings from VS Code config and push to webview.
   */
  private sendNotificationSettings(): void {
    const notifications = vscode.workspace.getConfiguration("testagent.new.notifications")
    const sounds = vscode.workspace.getConfiguration("testagent.new.sounds")
    this.postMessage({
      type: "notificationSettingsLoaded",
      settings: {
        notifyAgent: notifications.get<boolean>("agent", true),
        notifyPermissions: notifications.get<boolean>("permissions", true),
        notifyQuestions: notifications.get<boolean>("questions", true),
        notifyErrors: notifications.get<boolean>("errors", true),
        notifySubagent: notifications.get<boolean>("subagent", false),
        soundAgent: sounds.get<string>("agent", "default"),
        soundPermissions: sounds.get<string>("permissions", "default"),
        soundErrors: sounds.get<string>("errors", "default"),
      },
    })
  }

  private sendTimelineSetting(): void {
    const config = vscode.workspace.getConfiguration("testagent.new")
    this.postMessage({
      type: "timelineSettingLoaded",
      visible: config.get<boolean>("showTaskTimeline", true),
    })
  }

  // testagent_change: Route config writes to project files when keys originate there.
  // For nested objects (like "mcp"), split entries so global-only entries stay in global.
  private async routeConfigToSource(
    partial: Record<string, unknown>,
    dir: string,
  ): Promise<{ project: Record<string, Record<string, unknown>>; global: Record<string, unknown> }> {
    const project: Record<string, Record<string, unknown>> = {}
    const global: Record<string, unknown> = {}
    console.info("[TestAgent] routeConfigToSource start", { dir, keys: Object.keys(partial) })

    // Walk up from dir to find project config files.
    type FileContent = { file: string; parsed: Record<string, unknown> }
    const found: FileContent[] = []
    for (const subdir of [".testagent", ".opencode"]) {
      const names = subdir === ".testagent" ? ["testagent.jsonc", "testagent.json"] : ["opencode.jsonc", "opencode.json"]
      let current = dir
      while (true) {
        for (const name of names) {
          const f = path.join(current, subdir, name)
          try {
            const raw = fs.readFileSync(f, "utf-8")
            const parsed = jsonc.parse(raw)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              found.push({ file: f, parsed: parsed as Record<string, unknown> })
              console.info("[TestAgent] routeConfigToSource found file", { file: f, keys: Object.keys(parsed) })
            }
          } catch (e) {
            const err = e as NodeJS.ErrnoException
            if (err.code !== "ENOENT") {
              console.warn("[TestAgent] routeConfigToSource parse error", { file: f, error: String(e) })
            }
          }
        }
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }

    // Route each top-level key. For nested objects, split entries between project/global.
    for (const [key, value] of Object.entries(partial)) {
      // Find the highest-priority project file that has this key.
      const match = found.find((f) => key in f.parsed)
      if (!match) {
        // testagent_change start - route new mcp entries to first project config file
        if (key === "mcp" && found.length > 0) {
          const first = found[0]!
          project[first.file] = project[first.file] ?? {}
          project[first.file]![key] = value
          console.info("[TestAgent] routeConfigToSource routed new mcp to project", { file: first.file })
          continue
        }
        // testagent_change end
        global[key] = value
        continue
      }

      const existing = match.parsed[key]
      const file = match.file
      project[file] = project[file] ?? {}

      // Non-object values: route entirely to project.
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        project[file]![key] = value
        console.info("[TestAgent] routeConfigToSource routed to project", { file, key })
        continue
      }

      // Nested object: split entries by whether they exist in the project file.
      const src = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {}
      const projectPart: Record<string, unknown> = {}
      const globalPart: Record<string, unknown> = {}
      // testagent_change start - route all mcp entries to project when mcp key already exists in a project file
      const isMcp = key === "mcp"
      // testagent_change end
      for (const [nested, nestedVal] of Object.entries(value as Record<string, unknown>)) {
        if (nested in src || isMcp) { // testagent_change
          projectPart[nested] = nestedVal
        } else {
          globalPart[nested] = nestedVal
        }
      }

      if (Object.keys(projectPart).length > 0) {
        project[file]![key] = projectPart
        console.info("[TestAgent] routeConfigToSource routed to project (nested)", { file, key, entries: Object.keys(projectPart) })
      }
      if (Object.keys(globalPart).length > 0) {
        global[key] = { ...((global[key] as Record<string, unknown>) ?? {}), ...globalPart }
        console.info("[TestAgent] routeConfigToSource kept in global (nested)", { key, entries: Object.keys(globalPart) })
      }
    }

    console.info("[TestAgent] routeConfigToSource result", {
      projectFiles: Object.keys(project),
      globalKeys: Object.keys(global),
    })
    return { project, global }
  }

  // testagent_change: Read a project config file, deep-merge the patch, and write back.
  private async writeConfigFile(file: string, patch: Record<string, unknown>): Promise<void> {
    const raw = await fs.promises.readFile(file, "utf-8")
    let existing: Record<string, unknown> = {}
    try { existing = (jsonc.parse(raw) ?? {}) as Record<string, unknown> } catch (e) {
      console.warn("[TestAgent] writeConfigFile parse failed", { file, error: String(e) })
    } 
    console.info("[TestAgent] writeConfigFile writing", { file, patchKeys: Object.keys(patch) })
    if (typeof existing !== "object" || Array.isArray(existing)) existing = {}
    const merged = deepMerge(existing, patch)
    const cleaned = removeNulls(merged)
    await fs.promises.writeFile(file, JSON.stringify(cleaned, null, 2) + "\n", "utf-8")
    console.info("[TestAgent] writeConfigFile done", { file })
  }

  /** Returns the number of sessions currently in "busy" state. */
  private getBusySessionCount(): number {
    return getBusySessionCount(this.sessionStatusMap)
  }

  /**
   * Handle config update request from the webview.
   * Routes writes to project config files when keys originate from there,
   * and to global config for the rest. Then pushes the merged config back.
   */
  private async handleUpdateConfig(partial: ConfigPatch): Promise<void> {
    console.info("[TestAgent] === handleUpdateConfig CALLED ===", { keys: Object.keys(partial), hasMcp: partial.mcp !== undefined })

    if (!this.client || this.connectionState !== "connected") {
      this.postMessage({ type: "configUpdateFailed", message: "Not connected to CLI backend" })
      return
    }

    const refreshProviders =
      partial.provider !== undefined ||
      partial.disabled_providers !== undefined ||
      partial.enabled_providers !== undefined

    const isMcpOnly = partial.mcp !== undefined && Object.keys(partial).length === 1

    if (isMcpOnly && this.getBusySessionCount() > 0) {
      this.postMessage({
        type: "configUpdateFailed",
        message: "无法在任务运行期间修改 MCP 配置",
        details: "Task is currently running. MCP configuration changes are not allowed during task execution.",
      })
      return
    }

    this.pending++

    // Phase 1: write. Route keys to project or global based on where they live.
    try {
      const dir = this.getWorkspaceDirectory()
      console.info("[TestAgent] handleUpdateConfig routing writes", { dir, keys: Object.keys(partial as Record<string, unknown>) })
      const { project, global } = await this.routeConfigToSource(partial as Record<string, unknown>, dir)

      for (const [file, patch] of Object.entries(project)) {
        console.info("[TestAgent] handleUpdateConfig writing to project file", { file })
        await this.writeConfigFile(file, patch)
      }

      if (Object.keys(global).length > 0) {
        console.info("[TestAgent] handleUpdateConfig writing to global", { keys: Object.keys(global) })
        await this.client.global.config.update({ config: global }, { throwOnError: true })
      }
    } catch (error) {
      console.error("[TestAgent]  Failed to update config:", error)
      this.postMessage({
        type: "configUpdateFailed",
        message: getErrorMessage(error) || "Failed to update config",
        details: getConfigErrorDetails(error),
      })
      this.pending--
      return
    }

    // testagent_change: For MCP-only changes, reload MCP servers via /mcp/reload
    if (isMcpOnly) {
      try {
        this.cachedMcpStatusMessage = null
        const sdkClient = (this.client as any).client
        if (sdkClient && typeof sdkClient.post === "function") {
          await sdkClient.post({ url: "/mcp/reload", body: {} })
        }
      } catch (e) {
        console.warn("[TestAgent] MCP reload after config update failed:", e)
      }
    }

    // Phase 2: refresh. Send the updated config to the webview.
    try {
      if (isMcpOnly) {
        const cached = (this.cachedConfigMessage as { config?: Record<string, unknown> } | null)?.config
        if (cached && typeof cached === "object") {
          const base = { ...cached }
          if (partial.mcp) {
            base.mcp = { ...((base.mcp as Record<string, unknown>) ?? {}) }
            for (const [name, value] of Object.entries(partial.mcp)) {
              if (value === null) {
                delete (base.mcp as Record<string, unknown>)[name]
              } else {
                ;(base.mcp as Record<string, unknown>)[name] = value
              }
            }
          }
          this.cachedConfigMessage = { type: "configLoaded", config: base }
          this.postMessage({ type: "configUpdated", config: base })
        } else {
          const dir = this.getWorkspaceDirectory()
          const { data: merged } = await retry(() => this.client!.config.get({ directory: dir }, { throwOnError: true }))
          this.cachedConfigMessage = { type: "configLoaded", config: merged }
          this.postMessage({ type: "configUpdated", config: merged })
        }
        await this.fetchAndSendMcpStatus()
      } else {
        const dir = this.getWorkspaceDirectory()
        const { data: merged } = await retry(() => this.client!.config.get({ directory: dir }, { throwOnError: true }))
        this.cachedConfigMessage = { type: "configLoaded", config: merged }
        this.postMessage({ type: "configUpdated", config: merged })
        if (refreshProviders) await this.fetchAndSendProviders()
      }
    } catch (error) {
      console.error("[TestAgent]  Config write succeeded but post-write refresh failed:", error)
      const cached = (this.cachedConfigMessage as { config?: unknown } | null)?.config
      const optimistic =
        cached && typeof cached === "object" ? { ...(cached as Record<string, unknown>), ...partial } : partial
      this.postMessage({ type: "configUpdated", config: optimistic })
    } finally {
      this.pending--
    }
  }

  /**
   * Ensure a session exists, creating one if needed. Returns the resolved
   * session ID and workspace directory, or undefined when the client is
   * disconnected.
   */
  private async resolveSession(
    sessionID?: string,
    draftID?: string,
  ): Promise<{ sid: string; dir: string } | undefined> {
    if (!this.client) return undefined

    const dir = sessionID ? this.getWorkspaceDirectory(sessionID) : this.getContextDirectory()

    if (!sessionID && !this.currentSession) {
      const { data: session } = await this.client.session.create({ directory: dir }, { throwOnError: true })
      this.currentSession = session
      this.contextSessionID = session.id
      this.trackDirectory(session.id, dir)
      this.trackedSessionIds.add(session.id)
      if (draftID) this.contextSessionID = session.id
      this.postMessage({
        type: "sessionCreated",
        session: this.sessionToWebview(session),
        draftID,
      })
    }

    const sid = sessionID || this.currentSession?.id
    if (!sid) throw new Error("No session available")
    this.trackedSessionIds.add(sid)
    return { sid, dir }
  }

  /** Abort controllers for active retry loops, keyed by session ID */
  private retryAbortControllers = new Map<string, AbortController>()

  /** Execute an SDK call with visible exponential backoff for retryable HTTP errors. */
  private async withRetry(
    fn: () => Promise<{ error?: unknown; response?: Response }>,
    sid: string,
    messageID?: string,
  ): Promise<void> {
    const abortController = new AbortController()
    this.retryAbortControllers.set(sid, abortController)

    try {
      for (let attempt = 1; ; attempt++) {
        if (abortController.signal.aborted) {
          // User cancelled — return normally without triggering sendMessageFailed
          return
        }

        const result = await fn()
        if (!result.error) return
        if (this.confirmations.has(messageID)) return

        const status = result.response?.status ?? 0

        // Non-retryable status codes fail immediately without retry
        if (!retryable(status)) {
          this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
          throw result.error
        }

        // Stop retrying after MAX_RETRIES attempts
        if (attempt >= MAX_RETRIES) {
          this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
          throw result.error
        }

        const delay = backoff(attempt, result.response?.headers)
        console.log(`[TestAgent]  Retry on ${status}, attempt ${attempt}/${MAX_RETRIES}, delay ${delay}ms`)

        this.postMessage({
          type: "sessionStatus",
          sessionID: sid,
          status: "retry",
          attempt,
          message: `Error (${status}). Retrying...`,
          next: Date.now() + delay,
        })

        // Wait for delay or until aborted
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            abortController.signal.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, delay)
          abortController.signal.addEventListener("abort", done, { once: true })
        })
        if (this.confirmations.has(messageID)) return
      }
    } finally {
      this.retryAbortControllers.delete(sid)
    }
  }

  /** Cancel an active retry loop for a session */
  private cancelRetry(sid: string): void {
    const controller = this.retryAbortControllers.get(sid)
    if (controller) {
      controller.abort()
      this.postMessage({ type: "sessionStatus", sessionID: sid, status: "idle" })
    }
  }

  // testagent_change start - testflow command handler
  private async handleSdtCommand(
    text: string,
    sessionID?: string,
    providerID?: string,
    modelID?: string,
    messageID?: string,
    agent?: string,
  ): Promise<void> {
    const parts = text.trim().split(/\s+/)
    const cmd = parts[0].slice(5) // strip "/sdt-"
    const args = parts.slice(1)

    const serverConfig = this.connectionService.getServerConfig()
    if (!serverConfig) {
      void vscode.window.showErrorMessage("TestAgent: Not connected to CLI backend")
      return
    }

    const resolved = await this.resolveSession(sessionID)
    if (!resolved) {
      void vscode.window.showErrorMessage("TestAgent: Not connected to CLI backend")
      return
    }
    // testagent_change start
    // ===== 交互式分支：/sdt-run 无 stage_id 参数，弹出阶段选择面板 =====
    if (cmd === "run" && args.length === 0) {
      await handleInteractiveRun(
        {
          sdtRunner: this.sdtRunner,
          localQuestionMap: this.localQuestionMap,
          postMessage: (msg) => this.postMessage(msg),
          showErrorMessage: (msg) => void vscode.window.showErrorMessage(msg),
        },
        resolved,
        serverConfig,
        { providerID, modelID, agent, messageID, sessionID },
      )
      return
    }
    // testagent_change end

    this.sdtRunner.run({
      cmd,
      args,
      cwd: resolved.dir,
      env: {
        OPENCODE_SERVER_URL: serverConfig.baseUrl,
        OPENCODE_SERVER_PASSWORD: serverConfig.password,
        OPENCODE_SESSION_ID: resolved.sid,
        OPENCODE_PROVIDER_ID: providerID || "",
        OPENCODE_MODEL_ID: modelID || "",
        OPENCODE_AGENT: agent,
        SDT_USER_TEXT: text,
      },
      sessionID: resolved.sid,
      userText: text,
      userMessageID: messageID,
      post: (msg) => this.postMessage(msg),
    })
  }

  // testagent_change start - task command handler (task-start / task-query)
  private async handleTaskCommand(text: string, sessionID?: string, messageID?: string): Promise<void> {
    const parts = text.trim().split(/\s+/)
    const raw = parts[0].slice(6) // strip "/task-"

    if (raw !== "query") {
      void vscode.window.showErrorMessage(`TestAgent: 未知 task 命令 "${raw}"`)
      return
    }

    const resolved = await this.resolveSession(sessionID)
    if (!resolved) {
      void vscode.window.showErrorMessage("TestAgent: Not connected to CLI backend")
      return
    }

    void runTaskCommand({
      cmd: "query",
      args: parts.slice(1),
      cwd: resolved.dir,
      sessionID: resolved.sid,
      userText: text,
      userMessageID: messageID,
      post: (msg) => this.postMessage(msg),
    })
  }
  // testagent_change end

  private async handleSendMessage(
    text: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
    variant?: string,
    files?: MessageFile[],
    goal?: string,
  ): Promise<void> {
    // testagent_change start - intercept /sdt-* commands for testflow
    if (text.startsWith("/sdt-")) {
      await this.handleSdtCommand(text, sessionID, providerID, modelID, messageID, agent)
      return
    }
    // testagent_change end
    // testagent_change start - intercept /task-* commands
    if (text.startsWith("/task-")) {
      await this.handleTaskCommand(text, sessionID, messageID)
      return
    }
    // testagent_change end

    if (!this.client) {
      this.postMessage({
        type: "sendMessageFailed",
        error: "Not connected to CLI backend",
        text,
        sessionID,
        draftID,
        messageID,
        files,
      })
      return
    }

    let resolved: { sid: string; dir: string } | undefined
    try {
      resolved = await this.resolveSession(sessionID, draftID)

      const parts: Array<TextPartInput | FilePartInput> = []
      if (files) {
        for (const f of files) {
          parts.push({ type: "file", mime: f.mime, url: f.url, filename: f.filename, source: f.source })
        }
      }
      parts.push({ type: "text", text })

      const editorContext = await this.gatherEditorContext()
      console.log("[TestAgent] 🔍 EditorContext collected:", JSON.stringify(editorContext, null, 2))

      if (messageID) {
        this.connectionService.recordMessageSessionId(messageID, resolved!.sid)
      }

      const sid = resolved!.sid
      const dir = resolved!.dir
      await runWithMessageConfirmation(this.confirmations, messageID, " Message request", () =>
        this.withRetry(
          () =>
            this.client!.session.promptAsync({
              sessionID: sid,
              directory: dir,
              messageID,
              parts,
              model: providerID && modelID ? { providerID, modelID } : undefined,
              agent,
              variant,
              editorContext,
            }),
          sid,
          messageID,
        ),
      )
    } catch (error) {
      console.error("[TestAgent]  Failed to send message:", error)
      this.postMessage({
        type: "sendMessageFailed",
        error: getErrorMessage(error) || "Failed to send message",
        text,
        sessionID: resolved?.sid ?? sessionID,
        draftID,
        messageID,
        files,
      })
    }
  }

  private async handleSendCommand(
    command: string,
    args: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
    providerID?: string,
    modelID?: string,
    agent?: string,
    variant?: string,
    files?: MessageFile[],
    goal?: string,
  ): Promise<void> {
    // testagent_change start - intercept sdt-* commands for testflow
    if (command.startsWith("sdt-")) {
      await this.handleSdtCommand(`/${command} ${args}`.trim(), sessionID, providerID, modelID, messageID, agent)
      return
    }
    // testagent_change end
    // testagent_change start - intercept task-* commands
    if (command.startsWith("task-")) {
      await this.handleTaskCommand(`/${command} ${args}`.trim(), sessionID, messageID)
      return
    }
    // testagent_change end

    // testagent_change start - Check CLI connection status
    console.log("[TestAgent] 🔍 handleSendCommand called:", {
      command,
      hasClient: !!this.client,
    })
    // testagent_change end

    if (!this.client) {
      this.postMessage({
        type: "sendMessageFailed",
        error: "Not connected to CLI backend",
        text: `/${command} ${args}`.trim(),
        sessionID,
        draftID,
        messageID,
        files,
      })
      return
    }

    let resolved: { sid: string; dir: string } | undefined
    const startTime = Date.now() // testagent_change - move outside try block
    try {
      resolved = await this.resolveSession(sessionID, draftID)

      if (messageID) {
        this.connectionService.recordMessageSessionId(messageID, resolved!.sid)
      }

      const parts = files?.map((f) => ({
        type: "file" as const,
        mime: f.mime,
        url: f.url,
        filename: f.filename,
        source: f.source,
      }))

      const sid = resolved!.sid
      const dir = resolved!.dir
      await runWithMessageConfirmation(this.confirmations, messageID, " Command request", () =>
        this.withRetry(
          () =>
            this.client!.session.command({
              sessionID: sid,
              directory: dir,
              command,
              arguments: args,
              goal,
              messageID,
              model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
              agent,
              variant,
              parts,
            }),
          sid,
          messageID,
        ),
      )
      // testagent_change end

      const duration = Date.now() - startTime // testagent_change
      console.log("[TestAgent] ✅ Command sent successfully", { duration: `${duration}ms` }) // testagent_change
    } catch (error: any) {
      const duration = Date.now() - startTime // testagent_change
      console.error("[TestAgent]  Failed to send command:", error)
      console.error("[TestAgent] Error details:", {
        name: error?.name,
        message: error?.message,
        cause: error?.cause,
        code: error?.code, // testagent_change - capture error code
        duration: `${duration}ms`, // testagent_change
        stack: error?.stack,
      })
      this.postMessage({
        type: "sendMessageFailed",
        error: getErrorMessage(error) || "Failed to send command",
        text: `/${command} ${args}`.trim(),
        sessionID: resolved?.sid ?? sessionID,
        draftID,
        messageID,
        files,
      })
    }
  }

  // testagent_change start - 修改继续任务方法调用 resume API
  private async handleContinueTask(
    sessionID?: string,
    messageID?: string,
    providerID?: string,
    modelID?: string,
  ): Promise<void> {
    console.log("[TestAgent] 🔄 handleContinueTask called:", { sessionID, messageID, providerID, modelID })

    if (!this.client) {
      console.error("[TestAgent] ❌ Cannot continue task: not connected to CLI backend")
      return
    }

    if (!sessionID) {
      console.error("[TestAgent] ❌ Cannot continue task: no session ID")
      return
    }

    if (!messageID) {
      console.error("[TestAgent] ❌ Cannot continue task: no message ID")
      return
    }

    try {
      const dir = this.getWorkspaceDirectory(sessionID)

      this.connectionService.recordMessageSessionId(messageID, sessionID)

      console.log("[TestAgent] 📤 Calling resume API:", { sessionID, messageID, dir, providerID, modelID })

      await runWithMessageConfirmation(this.confirmations, messageID, "Resume task request", () =>
        this.withRetry(
          () =>
            this.client!.session.resume({
              sessionID,
              messageID,
              directory: dir,
              ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
            }),
          sessionID,
          messageID,
        ),
      )

      console.log("[TestAgent] ✅ Resume task request sent successfully")
    } catch (error: any) {
      console.error("[TestAgent] ❌ Failed to resume task:", error)
      console.error("[TestAgent] Error details:", {
        name: error?.name,
        message: error?.message,
        cause: error?.cause,
        code: error?.code,
        stack: error?.stack,
      })
    }
  }
  // testagent_change end

  private async handleAbort(sessionID?: string, queuedMessageIDs: string[] = [], reason?: string): Promise<void> {
    if (!this.client) {
      return
    }

    const targetSessionID = sessionID || this.currentSession?.id
    if (!targetSessionID) {
      return
    }

    try {
      console.log('触发了abort  掉后端接口')
      await abortSession({
        client: this.client,
        sessionID: targetSessionID,
        dir: this.getWorkspaceDirectory(targetSessionID),
        queuedMessageIDs,
        reason: reason as "completed" | "user_abort" | "error" | undefined,
      })
    } catch (error) {
      console.error("[TestAgent]  Failed to abort session:", error)
    }
  }

  private async handleRevertSession(sessionID: string, messageID: string): Promise<void> {
    if (!this.client) return
    const dir = this.getWorkspaceDirectory(sessionID)
    const { data, error } = await this.client.session.revert({ sessionID, messageID, directory: dir })
    if (error) {
      console.error("[TestAgent]  Failed to revert session:", error)
      this.postMessage({ type: "error", message: "Failed to revert session", sessionID })
      return
    }
    if (data) this.postMessage({ type: "sessionUpdated", session: sessionToWebview(data) })
  }

  private async handleUnrevertSession(sessionID: string): Promise<void> {
    if (!this.client) return
    const dir = this.getWorkspaceDirectory(sessionID)
    const { data, error } = await this.client.session.unrevert({ sessionID, directory: dir })
    if (error) {
      console.error("[TestAgent]  Failed to unrevert session:", error)
      this.postMessage({ type: "error", message: "Failed to redo session", sessionID })
      return
    }
    if (data) this.postMessage({ type: "sessionUpdated", session: sessionToWebview(data) })
  }

  /**
   * Handle compact (context summarization) request from the webview.
   */
  private async handleCompact(sessionID?: string, providerID?: string, modelID?: string): Promise<void> {
    if (!this.client) {
      this.postMessage({
        type: "error",
        message: "Not connected to CLI backend",
      })
      return
    }

    const target = sessionID || this.currentSession?.id
    if (!target) {
      console.error("[TestAgent]  No sessionID for compact")
      return
    }

    if (!providerID || !modelID) {
      console.error("[TestAgent]  No model selected for compact")
      this.postMessage({
        type: "error",
        message: "No model selected. Connect a provider to compact this session.",
      })
      return
    }

    try {
      const workspaceDir = this.getWorkspaceDirectory(target)
      await this.client.session.summarize(
        { sessionID: target, directory: workspaceDir, providerID, modelID },
        { throwOnError: true },
      )
    } catch (error) {
      console.error("[TestAgent]  Failed to compact session:", error)
      this.postMessage({
        type: "error",
        message: getErrorMessage(error) || "Failed to compact session",
      })
    }
  }

  // Permission + question handlers extracted to kilo-provider/handlers/permission.ts and question.ts

  private get permissionCtx(): PermissionContext {
    return {
      client: this.client,
      currentSessionId: this.currentSession?.id,
      trackedSessionIds: this.trackedSessionIds,
      sessionDirectories: this.sessionDirectories,
      postMessage: (msg) => this.postMessage(msg),
      getWorkspaceDirectory: (sid) => this.getWorkspaceDirectory(sid),
    }
  }

  private get questionCtx() {
    return {
      client: this.client,
      currentSessionId: this.currentSession?.id,
      trackedSessionIds: this.trackedSessionIds,
      sessionDirectories: this.sessionDirectories,
      postMessage: (msg: unknown) => this.postMessage(msg),
      getWorkspaceDirectory: (sid?: string) => this.getWorkspaceDirectory(sid),
    }
  }

  // Cloud session handlers extracted to kilo-provider/handlers/cloud-session.ts

  private get cloudSessionCtx(): CloudSessionContext {
    const self = this
    return {
      client: this.client,
      get currentSession() {
        return self.currentSession
      },
      set currentSession(session) {
        self.currentSession = session
        if (session) self.contextSessionID = session.id
      },
      trackedSessionIds: this.trackedSessionIds,
      connectionService: this.connectionService,
      postMessage: (msg) => this.postMessage(msg),
      getWorkspaceDirectory: (sid) => this.getWorkspaceDirectory(sid),
      gatherEditorContext: () => this.gatherEditorContext(),
      runWithMessageConfirmation: (id, label, run) => runWithMessageConfirmation(this.confirmations, id, label, run),
    }
  }

  // Auth handlers extracted to kilo-provider/handlers/auth.ts

  private get authCtx(): AuthContext {
    return {
      client: this.client,
      postMessage: (msg) => this.postMessage(msg),
      getWorkspaceDirectory: () => this.getWorkspaceDirectory(),
      disposeGlobal: () => this.disposeGlobal(),
      fetchAndSendProviders: () => this.fetchAndSendProviders(),
      fetchAndSendAgents: () => this.fetchAndSendAgents(),
    }
  }

  private async disposeGlobal(): Promise<void> {
    if (!this.client) return

    await this.client.global
      .dispose()
      .catch((e: unknown) => console.warn("[TestAgent]  global.dispose() after org switch failed:", e))

    // Org switch succeeded — refresh profile and providers independently (best-effort)
    try {
      // testagent_change start - disable profile API (not available in testagent backend)
      // const profileResult = await this.client!.kilo.profile()
      // // Broadcast to all webviews (sidebar, profile tab, agent manager, etc.)
      // this.connectionService.notifyProfileChanged(profileResult.data ?? null)
      console.log("[TestAgent]  👤 Skipping profile refresh after org switch (not available)")
      this.connectionService.notifyProfileChanged(null)
      // testagent_change end
    } catch (error) {
      console.error("[TestAgent]  Failed to refresh profile after org switch:", error)
    }
    try {
      await this.fetchAndSendProviders()
    } catch (error) {
      console.error("[TestAgent]  Failed to refresh providers after org switch:", error)
    }
  }

  private handlePreviewImage(dataUrl: string, filename: string): void {
    const dir = this.extensionContext?.globalStorageUri
    if (!dir) return

    const img = parseImage(dataUrl, filename)
    if (!img) return

    const root = vscode.Uri.joinPath(dir, getPreviewDir())
    const uri = vscode.Uri.joinPath(dir, buildPreviewPath(img.name, Date.now()))
    const clean = () =>
      vscode.workspace.fs.readDirectory(root).then(
        (items) => {
          const stale = trimEntries(items.map(([name]) => ({ path: name })))
          return Promise.all(
            stale.map((name) =>
              Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.joinPath(root, name), { recursive: true })).then(
                undefined,
                (err: unknown) => {
                  console.warn("[TestAgent]  Failed to delete stale preview:", err)
                },
              ),
            ),
          )
        },
        () => [],
      )
    const open = () =>
      vscode.commands
        .executeCommand(...getPreviewCommand(uri))
        .then(undefined, () => vscode.commands.executeCommand("vscode.open", uri))

    void vscode.workspace.fs
      .createDirectory(root)
      .then(() => vscode.workspace.fs.writeFile(uri, img.data))
      .then(() => clean())
      .then(open, (err) => console.error("[TestAgent]  Failed to preview image:", err))
  }

  // testagent_change start
  private async handleExportConversation(markdown: string, title: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      filters: { Markdown: ["md"] },
      defaultUri: vscode.Uri.file(`${title.replace(/[/\\?%*:|"<>]/g, "-")}.md`),
    })
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, "utf-8"))
      void vscode.window.showInformationMessage(`对话已导出到 ${uri.fsPath}`)
    }
  }
  // testagent_change end

  /**
   * Handle openFile request from the webview — open a file in the VS Code editor.
   * Resolves relative paths against the current session's directory (which may be
   * a worktree path registered via setSessionDirectory), falling back to workspace root.
   * Absolute paths (Unix `/…` or Windows `C:\…`) are used as-is.
   */
  private handleOpenFile(filePath: string, line?: number, column?: number): void {
    const uri = isAbsolutePath(filePath)
      ? vscode.Uri.file(filePath)
      : vscode.Uri.joinPath(vscode.Uri.file(this.getWorkspaceDirectory(this.currentSession?.id)), filePath)
    vscode.workspace.openTextDocument(uri).then(
      (doc) => {
        const options: vscode.TextDocumentShowOptions = { preview: true }
        if (line !== undefined && line > 0) {
          const col = column !== undefined && column > 0 ? column - 1 : 0
          const pos = new vscode.Position(line - 1, col)
          options.selection = new vscode.Range(pos, pos)
        }
        vscode.window.showTextDocument(doc, options)
      },
      (err) => console.error("[TestAgent]  Failed to open file:", uri.fsPath, err),
    )
  }

  /**
   * Handle openConfigFile request from the webview — open or create testagent config file.
   * For local scope: checks workspace folder, creates .testagent/testagent.jsonc if needed.
   * For global scope: opens global config file directly.
   */
  private async handleOpenConfigFile(scope: "local" | "global"): Promise<void> {
    const path = await import("path")
    const fs = await import("fs/promises")
    const os = await import("os")

    if (scope === "local") {
      // Check if workspace folder is open
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage("打开工作区文件夹以编辑项目testagent 配置文件")
        return
      }

      // Use the first workspace folder
      const workspaceRoot = workspaceFolders[0]!.uri.fsPath
      const configDir = path.join(workspaceRoot, ".testagent")
      const configFile = path.join(configDir, "testagent.jsonc")

      try {
        // Check if config file exists
        await fs.access(configFile)
        // File exists, open it
        const doc = await vscode.workspace.openTextDocument(configFile)
        await vscode.window.showTextDocument(doc)
      } catch {
        // File doesn't exist, create it
        try {
          await fs.mkdir(configDir, { recursive: true })
          const defaultConfig = `{
  // TestAgent 项目配置
  // 更多配置选项请参考: ${decodeURIComponent(atob("aHR0cHMlM0ElMkYlMkZ0c2NvZGUtZ2F0ZXdheS5wYWFzdWF0LmNtYmNoaW5hLmNu"))}/help/testagent
  "$schema": "https://opencode.ai/config.json"
}
`
          await fs.writeFile(configFile, defaultConfig, "utf-8")
          const doc = await vscode.workspace.openTextDocument(configFile)
          await vscode.window.showTextDocument(doc)
        } catch (err) {
          console.error("[TestAgent] Failed to create config file:", err)
          vscode.window.showErrorMessage(`创建配置文件失败: ${err}`)
        }
      }
    } else {
      // Global scope - open global config file
      const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
      const configDir = path.join(xdg, "testagent")
      const candidates = ["testagent.jsonc", "testagent.json", "opencode.jsonc", "opencode.json", "config.json"]

      let configFile: string | null = null

      // Check for existing config files
      for (const candidate of candidates) {
        const filePath = path.join(configDir, candidate)
        try {
          await fs.access(filePath)
          configFile = filePath
          break
        } catch {
          // File doesn't exist, continue
        }
      }

      // If no config file exists, create testagent.jsonc
      if (!configFile) {
        configFile = path.join(configDir, "testagent.jsonc")
        try {
          await fs.mkdir(configDir, { recursive: true })
          const defaultConfig = `{
  // TestAgent 全局配置
  // 更多配置选项请参考: ${decodeURIComponent(atob("aHR0cHMlM0ElMkYlMkZ0c2NvZGUtZ2F0ZXdheS5wYWFzdWF0LmNtYmNoaW5hLmNu"))}/help/testagent
  "$schema": "https://opencode.ai/config.json"
}
`
          await fs.writeFile(configFile, defaultConfig, "utf-8")
        } catch (err) {
          console.error("[TestAgent] Failed to create global config file:", err)
          vscode.window.showErrorMessage(`创建全局配置文件失败: ${err}`)
          return
        }
      }

      // Open the config file
      try {
        const doc = await vscode.workspace.openTextDocument(configFile)
        await vscode.window.showTextDocument(doc)
      } catch (err) {
        console.error("[TestAgent] Failed to open global config file:", err)
        vscode.window.showErrorMessage(`打开全局配置文件失败: ${err}`)
      }
    }
  }

  private async sendMemorySettings(): Promise<void> {
    const file = memoryPath()
    try {
      const txt = await fs.promises.readFile(file, "utf-8")
      this.postMessage({ type: "memorySettingsLoaded", settings: memorySettings(JSON.parse(txt || "{}")), path: file })
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        this.postMessage({ type: "memorySettingsLoaded", settings: memoryDefaults, path: file })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({ type: "memorySettingsLoaded", settings: memoryDefaults, path: file, error: message })
    }
  }

  private async saveMemorySettings(input: unknown): Promise<void> {
    const file = memoryPath()
    try {
      const cfg = memorySettings(input)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8")
      this.postMessage({
        type: "memorySettingsSaved",
        settings: cfg,
        path: file,
        reloaded: await this.reloadMemoryPlugin(),
      })
    } catch (err) {
      this.postMessage({ type: "memorySettingsFailed", message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async reloadMemoryPlugin(): Promise<boolean> {
    if (!this.client || this.connectionState !== "connected") return false
    try {
      this.clearCommandsCache()
      await this.client.instance.dispose({ directory: this.getWorkspaceDirectory() })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await this.fetchAndSendCommands()
      return true
    } catch (err) {
      console.warn("[TestAgent] memory plugin reload failed:", err)
      return false
    }
  }

  /**
   * Handle a generic setting update from the webview.
   * The key uses dot notation relative to `testagent.new` (e.g. "browserAutomation.enabled").
   */
  private async handleUpdateSetting(key: string, value: unknown): Promise<void> {
    const { section, leaf } = buildSettingPath(key)
    const config = vscode.workspace.getConfiguration(`testagent.new${section ? `.${section}` : ""}`)
    await config.update(leaf, value, vscode.ConfigurationTarget.Global)
  }

  // testagent_change start - notification methods
  /**
   * Show notification when agent completes a task (transitions from busy to idle).
   * Only shows if:
   * - Webview is not visible
   * - Notification setting is enabled
   */
  private maybeShowAgentCompletionNotification(
    sessionID: string,
    prevStatus: SessionStatus["type"] | undefined,
    reason: string | undefined,
  ): void {
    // Only notify on busy → idle transition with reason "completed"
    if (prevStatus !== "busy" || reason !== "completed") {
      return
    }

    console.log("[TestAgent] ✅ Step 1: Is busy→idle transition")

    // Only notify if this provider is tracking the session
    // This prevents duplicate notifications when multiple KiloProvider instances exist
    // (sidebar, settings panel, tabs, etc.)
    if (!this.trackedSessionIds.has(sessionID)) {
      console.log("[TestAgent] ❌ Session not tracked by this provider, skipping notification")
      return
    }

    console.log("[TestAgent] ✅ Step 2: Session is tracked by this provider")

    if (syncedChildSessions.has(sessionID)) {
      console.log("[TestAgent] ❌ Child session completed, skipping notification")
      return
    }

    console.log("[TestAgent] ✅ Step 3: Session is not a child session")

    // Check if notification is enabled
    const notifications = vscode.workspace.getConfiguration("testagent.new.notifications")
    const notifyAgent = notifications.get<boolean>("agent", true)
    console.log("[TestAgent] 📋 Notification setting:", notifyAgent)

    if (!notifyAgent) {
      console.log("[TestAgent] ❌ Notification disabled in settings")
      return
    }

    // Get task name from current session
    let taskName = "任务"

    // Try to get from currentSession first
    if (this.currentSession?.id === sessionID && this.currentSession.title) {
      taskName = this.currentSession.title
      console.log("[TestAgent] 📋 Task name from currentSession:", taskName)
    } else if (this.client) {
      // If not available, try to fetch it asynchronously (don't wait)
      this.client.session
        .get({ sessionID })
        .then((r) => {
          if (r.data?.title) {
            console.log("[TestAgent] 📋 Task name from API:", r.data.title)
          }
        })
        .catch(() => {})
    }

    // Show system notification with task name
    this.systemNotification.notify({
      title: this.currentSession?.title ?? "TestAgent",
      message: `${taskName}`,
      type: "info",
      onClick: () => this.revealWebview(),
    })

    console.log("[TestAgent] 📢 Notification method called")

    // Play sound if configured
    this.playNotificationSound("agent")
  }

  /**
   * Show notification when permission is requested.
   * Only shows if:
   * - Webview is not visible
   * - Notification setting is enabled
   */
  private maybeShowPermissionNotification(sessionID: string, permission: string): void {
    // Check if notification is enabled
    const notifications = vscode.workspace.getConfiguration("testagent.new.notifications")
    const notifyPermissions = notifications.get<boolean>("permissions", true)
    if (!notifyPermissions) return

    const isChild = syncedChildSessions.has(sessionID)
    // Subagent notifications are opt-in (default off)
    if (isChild) {
      const notifySubagent = notifications.get<boolean>("subagent", true)
      if (!notifySubagent) return
    }

    const prefix = isChild ? "[子任务] " : ""
    const title = isChild ? "TestAgent" : (this.currentSession?.title ?? "TestAgent")

    console.log("[TestAgent] ✅ Showing permission notification")

    this.systemNotification.notify({
      title,
      message: `${prefix}需要权限：${permission}`,
      type: "warning",
      onClick: () => this.revealWebview(),
    })

    // Play sound if configured
    this.playNotificationSound("permissions")
  }

  /**
   * Show notification when the agent asks a question.
   * Only shows if:
   * - Webview is not visible
   * - Notification setting is enabled
   */
  private maybeShowQuestionNotification(sessionID: string, question: string): void {
    // Check if notification is enabled
    const notifications = vscode.workspace.getConfiguration("testagent.new.notifications")
    const notifyQuestions = notifications.get<boolean>("questions", true)
    if (!notifyQuestions) return

    const isChild = syncedChildSessions.has(sessionID)
    if (isChild) {
      const notifySubagent = notifications.get<boolean>("subagent", true)
      if (!notifySubagent) return
    }

    const prefix = isChild ? "[子任务] " : ""
    const title = isChild ? "TestAgent" : (this.currentSession?.title ?? "TestAgent")

    console.log("[TestAgent] ✅ Showing question notification")

    this.systemNotification.notify({
      title,
      message: `${prefix}需要选择：${question}`,
      type: "info",
      onClick: () => this.revealWebview(),
    })

    // Play sound if configured
    this.playNotificationSound("questions")
  }

  /**
   * Show notification when an error occurs.
   * Only shows if:
   * - Webview is not visible
   * - Notification setting is enabled
   */
  private maybeShowErrorNotification(sessionID: string, error: string): void {
    // Check if notification is enabled
    const notifications = vscode.workspace.getConfiguration("testagent.new.notifications")
    const notifyErrors = notifications.get<boolean>("errors", true)
    if (!notifyErrors) return

    const isChild = syncedChildSessions.has(sessionID)
    if (isChild) {
      const notifySubagent = notifications.get<boolean>("subagent", true)
      if (!notifySubagent) return
    }

    const prefix = isChild ? "[子任务] " : ""
    const title = isChild ? "TestAgent" : (this.currentSession?.title ?? "TestAgent")

    console.log("[TestAgent] ✅ Showing error notification")

    this.systemNotification.notify({
      title,
      message: `${prefix}发生错误：${error}`,
      type: "error",
      onClick: () => this.revealWebview(),
    })

    // Play sound if configured
    this.playNotificationSound("errors")
  }

  /**
   * Check if the webview is currently visible (sidebar or panel).
   */
  private isWebviewVisible(): boolean {
    // For sidebar, check the actual visibility of the webviewView
    if (this.webviewView) {
      const visible = this.webviewView.visible
      console.log("[TestAgent] 👁️ isWebviewVisible check (sidebar):", {
        hasView: true,
        visible,
      })
      return visible
    }

    // Fallback: if no view reference, assume visible if webview exists
    const fallback = this.webview !== null && this.isWebviewReady
    console.log("[TestAgent] 👁️ isWebviewVisible check (fallback):", {
      hasWebview: this.webview !== null,
      isReady: this.isWebviewReady,
      result: fallback,
    })
    return fallback
  }

  /**
   * Reveal the webview (sidebar or panel).
   */
  private revealWebview(): void {
    // Focus the TestAgent sidebar view
    vscode.commands.executeCommand("testagent.new.focus")
  }

  /**
   * Play notification sound based on user settings.
   * Currently only logs - actual sound playback would require audio files.
   */
  private playNotificationSound(type: "agent" | "permissions" | "questions" | "errors"): void {
    const sounds = vscode.workspace.getConfiguration("testagent.new.sounds")
    const sound = sounds.get<string>(type, "default")

    if (sound === "none") return

    // TODO: Implement actual sound playback
    // This would require:
    // 1. Audio files in the extension
    // 2. A way to play them (e.g., via webview or native API)
    console.log(`[TestAgent] Would play ${type} notification sound: ${sound}`)
  }
  // testagent_change end

  /**
   * Reset all "testagent.new.*" extension settings to their defaults by reading
   * contributes.configuration from the extension's package.json at runtime.
   * Only resets settings under the "testagent.new." namespace to avoid touching
   * settings from the previous version of the extension which shares the same
   * extension ID and "kilo-code.*" namespace.
   */
  private async handleResetAllSettings(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "Reset all TestAgent extension settings to defaults?",
      { modal: true },
      "Reset",
    )
    if (confirmed !== "Reset") return

    const prefix = "testagent.new."
    const ext = vscode.extensions.getExtension("testagent.testagent-vscode")
    const properties = ext?.packageJSON?.contributes?.configuration?.properties as Record<string, unknown> | undefined
    if (!properties) return

    for (const key of Object.keys(properties)) {
      if (!key.startsWith(prefix)) continue
      const parts = key.split(".")
      const section = parts.slice(0, -1).join(".")
      const leaf = parts[parts.length - 1]!
      const config = vscode.workspace.getConfiguration(section)
      await config.update(leaf, undefined, vscode.ConfigurationTarget.Global)
    }

    // Clear globalState items that are not part of the configuration
    await this.extensionContext?.globalState.update("variantSelections", undefined)
    await this.extensionContext?.globalState.update("recentModels", undefined)
    await this.extensionContext?.globalState.update("kilo.dismissedNotificationIds", undefined)

    // Re-send all settings to the webview so the UI reflects the reset
    this.sendAutocompleteSettings()
    this.sendBrowserSettings()
    this.sendNotificationSettings()
    this.sendTimelineSetting()
    await ModelState.reset(this.client, (msg) => this.postMessage(msg))

    // Re-send globalState items to the webview
    this.postMessage({ type: "variantsLoaded", variants: {} })
    this.postMessage({ type: "recentsLoaded", recents: [] })

    // Re-fetch notifications to reflect cleared dismissed IDs
    // await this.fetchAndSendNotifications()

    vscode.window.showInformationMessage("TestAgent settings have been reset to defaults.")
  }

  /**
   * Read the current browser automation settings and push them to the webview.
   */
  private sendBrowserSettings(): void {
    const config = vscode.workspace.getConfiguration("testagent.new.browserAutomation")
    this.postMessage({
      type: "browserSettingsLoaded",
      settings: {
        enabled: config.get<boolean>("enabled", false),
        useSystemChrome: config.get<boolean>("useSystemChrome", true),
        headless: config.get<boolean>("headless", false),
      },
    })
  }

  /**
   * Read the current Claude Code compatibility setting and push it to the webview.
   */
  private sendClaudeCompatSetting(): void {
    const enabled = vscode.workspace.getConfiguration("testagent.new").get<boolean>("claudeCodeCompat", false)
    this.postMessage({
      type: "claudeCompatSettingLoaded",
      enabled: enabled ?? false,
    })
  }

  /** Restart the CLI backend process and reconnect. */
  private async handleRestartServer(logLevel?: string): Promise<void> {
    this.postMessage({ type: "connectionState", state: "connecting" })
    try {
      await this.connectionService.restart(this.getWorkspaceDirectory(), logLevel)
    } catch (e) {
      console.error("[TestAgent] restartServer failed:", e)
    }
  }

  private handleRemoteMessage(type: string, enabled?: boolean): void {
    this.remoteService
      ?.handleMessage(type, enabled)
      .then((s) => {
        if (s) this.sendRemoteStatus()
      })
      .catch((err) => console.error("[TestAgent] remote message failed:", err))
  }

  /** Re-fetch all server-side state after an auth change. */
  private async reloadAfterAuthChange(): Promise<void> {
    await Promise.all([
      this.fetchAndSendProviders(),
      this.fetchAndSendAgents(),
      this.fetchAndSendSkills(),
      this.fetchAndSendCommands(),
      this.fetchAndSendConfig(),
      // this.fetchAndSendNotifications(),
    ])
  }

  /**
   * Handle SSE events from the CLI backend.
   * Filters events by project ID and tracked session IDs so each webview only sees its own sessions.
   */
  private handleEvent(event: Event): void {
    if ((event as any).type === "kilo-sessions.remote-status-changed") {
      const ev = event as any
      this.remoteService?.updateFromEvent({ enabled: ev.properties.enabled, connected: ev.properties.connected })
      return
    }

    // Drop session events from other projects before any tracking logic.
    // This must come first: the trackedSessionIds guard below would otherwise
    // let a foreign session through if it was accidentally tracked.
    if (isEventFromForeignProject(event, this.projectID)) return

    if (event.type === "message.updated") {
      this.confirmations.confirm(event.properties.info.id)
    }

    // session.status events pass the onEventFiltered pre-filter for all providers (see line 842),
    // so this runs on every KiloProvider instance — including the Settings panel which has no
    // tracked sessions. Update sessionStatusMap and forward to webview before the
    // trackedSessionIds guard so the Settings panel's allStatusMap stays current for the
    // busy-session warning on Save.
    if (event.type === "session.status") {

      const sid = event.properties.sessionID
      const prevStatus = this.sessionStatusMap.get(sid)
      const newStatus = event.properties.status.type
      this.sessionStatusMap.set(sid, newStatus)
      const msg = mapSSEEventToWebviewMessage(event, sid)
      if (msg) {
        this.streams.flush(sid)
        this.postMessage(msg)
      }
      // testagent_change start - show notification when agent completes
      if (newStatus === "idle") {
        const reason = (event.properties.status as { reason?: string }).reason
        // testagent_change start - 子session idle时清理父session的 parentWithChildren 标记，
        // 让父session后续完成时能正常触发通知
        const parent = childToParent.get(sid)
        if (parent) {
          parentWithChildren.delete(parent)
          if (reason === "user_abort") {
            console.log("[TestAgent]  🧹 Child abort cleanup:", { childId: sid, parent, parentWithChildrenSize: parentWithChildren.size })
          }
        }
        // testagent_change end
        // Deduplicate completion notifications across KiloProvider instances
        if (!notifiedEventIds.has(event.id)) {
          notifiedEventIds.add(event.id)
          setTimeout(() => notifiedEventIds.delete(event.id), 1000)
          // Skip notifications for child/sub-agent sessions
          // Also skip if the parent has children — its idle may be child-result related
          if (!syncedChildSessions.has(sid) && !childToParent.has(sid) && !parentWithChildren.has(sid)) {
            this.maybeShowAgentCompletionNotification(sid, prevStatus, reason)
          }
        }
      }
      // testagent_change end
      return
    }

    // testagent_change start - handle session.info events to show VS Code notifications
    if ((event as any).type === "session.info") {
      const ev = event as any
      const message = ev.properties.message as string
      // Show info notification for plugin loading messages
      if (message.includes("plugin") || message.includes("Plugin")) {
        if (message.includes("✓") || message.includes("Successfully")) {
          vscode.window.showInformationMessage(`TestAgent: ${message}`)
        } else if (message.includes("Installing") || message.includes("Loading")) {
          // Show as status bar message for less intrusive notifications
          vscode.window.setStatusBarMessage(`TestAgent: ${message}`, 3000)
        }
      }
      // Forward to webview as well
      const msg = mapSSEEventToWebviewMessage(ev, ev.properties.sessionID as string | undefined)
      if (msg) this.postMessage(msg)
      return
    }
    // testagent_change end

    // testagent_change start - handle permission.asked events for notifications
    // Note: no early return here — the event must also be forwarded to the webview
    // via the normal mapSSEEventToWebviewMessage flow below.
    if (event.type === "permission.asked") {
      const sid = event.properties.sessionID
      const permission = event.properties.permission
      if (sid && (this.trackedSessionIds.has(sid) || childToParent.has(sid))) {
        // Deduplicate notification across KiloProvider instances — no early return,
        // the event must also be forwarded to the webview below.
        if (!notifiedEventIds.has(event.id)) {
          notifiedEventIds.add(event.id)
          setTimeout(() => notifiedEventIds.delete(event.id), 1000)
          this.maybeShowPermissionNotification(sid, permission)
        }
      }
    }
    // testagent_change end

    // testagent_change start - handle question.asked events for notifications
    // Note: no early return here — the event must also be forwarded to the webview
    // via the normal mapSSEEventToWebviewMessage flow below.
    if (event.type === "question.asked") {
      const sid = event.properties.sessionID
      const qs = event.properties.questions
      if (sid && qs && qs.length > 0 && (this.trackedSessionIds.has(sid) || childToParent.has(sid))) {
        // Deduplicate notification across KiloProvider instances — no early return,
        // the event must also be forwarded to the webview below.
        if (!notifiedEventIds.has(event.id)) {
          notifiedEventIds.add(event.id)
          setTimeout(() => notifiedEventIds.delete(event.id), 1000)

          // When multiple questions are asked, combine them into a summary
          const header = qs.length > 1
            ? qs.map((q: { header?: string; question?: string }) => q.header || q.question).join(", ")
            : (qs[0].header || qs[0].question)
          this.maybeShowQuestionNotification(sid, header)
        }
      }
    }
    // testagent_change end

    // testagent_change start - handle session.error events for notifications
    if (event.type === "session.error") {
      const sid = event.properties.sessionID
      const error = event.properties.error
      if (sid && error && (this.trackedSessionIds.has(sid) || childToParent.has(sid))) {
        // Deduplicate across KiloProvider instances
        if (notifiedEventIds.has(event.id)) return
        notifiedEventIds.add(event.id)
        setTimeout(() => notifiedEventIds.delete(event.id), 1000)

        // Skip notification for MessageAbortedError (user-initiated abort is not an error)
        const isAbortError =
          typeof error === "object" && error !== null && "name" in error && error.name === "MessageAbortedError"
        if (isAbortError) {
          return
        }

        // Extract error message from the error object
        // SDK error types: { name: "...", data: { message: "..." } }
        const errorMsg =
          typeof error === "string"
            ? error
            : typeof error === "object" && error !== null && "data" in error
              ? typeof error.data === "object" && error.data !== null && "message" in error.data && typeof error.data.message === "string"
                ? error.data.message
                : "发生错误"
              : "发生错误"
        this.maybeShowErrorNotification(sid, errorMsg)
      }
      return
    }
    // testagent_change end

    // Extract sessionID from the event
    if (event.type === "session.created" && this.adoptPendingFollowup(event.properties.info)) {
      return
    }

    const sessionID = this.connectionService.resolveEventSessionId(event)

    // Events without sessionID (server.connected, server.heartbeat) → always forward
    // Events with sessionID → only forward if this webview tracks that session
    // message.part.updated and message.part.delta are always session-scoped; drop if session unknown.
    if (!sessionID && (event.type === "message.part.updated" || event.type === "message.part.delta")) {
      return
    }
    if (sessionID && !this.trackedSessionIds.has(sessionID)) {
      return
    }

    // Refresh provider and agent lists when the server signals a state disposal
    if (event.type === "global.disposed") {
      void this.reloadAfterAuthChange()
      return
    }

    if (event.type === "server.instance.disposed") {
      const props = event.properties as Record<string, unknown> | null
      const dir = typeof props?.directory === "string" ? props.directory : undefined
      if (dir && path.resolve(dir) !== path.resolve(this.getWorkspaceDirectory())) return
      void this.reloadAfterAuthChange()
      return
    }

    // Config was updated without a full dispose (e.g. permission-only save).
    // Fetch and push the updated config so the Settings panel reflects the change.
    if ((event as any).type === "global.config.updated") {
      void this.fetchAndSendConfigUpdated()
      return
    }

    // Forward relevant events to webview
    // Side effects that must happen before the webview message is sent
    if (event.type === "session.created" && !this.currentSession) {
      console.log('event==============info', event.properties.info)
      this.currentSession = event.properties.info
      this.contextSessionID = event.properties.info.id
      this.trackedSessionIds.add(event.properties.info.id)
    }
    if (event.type === "session.updated" && this.currentSession?.id === event.properties.info.id) {
        console.log("[DEBUG] session.updated for currentSession", {                                              
        id: event.properties.info.id,                                                                          
        title: event.properties.info.title,                                                                    
        agent: event.properties.info.agent,                                                                    
      })  
      this.currentSession = event.properties.info
      this.contextSessionID = event.properties.info.id
    }

    // Auto-adopt child sessions as soon as the task tool part reveals their ID.
    // This means the child's permission/question events are tracked immediately —
    // before the webview renderer has a chance to call syncSession — eliminating
    // the race where the child blocks on a prompt that the UI never sees.
    if (event.type === "message.part.updated") {
      const part = event.properties.part as {
        type?: string
        tool?: string
        metadata?: { sessionId?: string }
        state?: { metadata?: { sessionId?: string } }
        sessionID?: string
      }
      const childId = childID(part)
        console.log("[DEBUG] message.part.updated", { childId, tool: part.tool, type: part.type, sessionID })
      if (childId && !this.trackedSessionIds.has(childId)) {
        console.log("[TestAgent]  🔗 Auto-adopting child session from task tool", { childId, parentId: part.sessionID ?? sessionID! })
        parentWithChildren.add(sessionID!)
        childToParent.set(childId, part.sessionID ?? sessionID!)
        void this.handleSyncSession(childId, part.sessionID ?? sessionID!)
      }
    }

    handleNetworkEvent(event.type as string, event.properties as any, this.client, (s) => this.getWorkspaceDirectory(s))

    const msg = mapSSEEventToWebviewMessage(event, sessionID)
    if (!msg) return
    if (msg.type === "partUpdated") {
      this.streams.push({ ...msg, part: this.slimPart(msg.part) })
      return
    }
    this.streams.flush(sessionID)
    this.postMessage(msg)
  }

  /**
   * Read autocomplete settings from VS Code configuration and push to the webview.
   */
  private sendAutocompleteSettings(): void {
    const config = vscode.workspace.getConfiguration("testagent.new.autocomplete")
    this.postMessage({
      type: "autocompleteSettingsLoaded",
      settings: {
        enableAutoTrigger: false,
        enableSmartInlineTaskKeybinding: false,
        enableChatAutocomplete: false,
      },
    })
  }

  /** Wait until the webview has sent "webviewReady". Resolves immediately when already ready. */
  public waitForReady(): Promise<void> {
    return this.isWebviewReady && this.webview ? Promise.resolve() : new Promise((r) => this.readyResolvers.push(r))
  }
  /** Post a message to the webview. Public so toolbar button commands can send messages. */
  public postMessage(message: unknown): void {
    if (!this.webview) {
      const type =
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        typeof (message as { type?: unknown }).type === "string"
          ? (message as { type: string }).type
          : "<unknown>"
      console.warn("[TestAgent]  ⚠️ postMessage dropped (no webview)", { type })
      return
    }

    void this.webview.postMessage(message).then(undefined, (error) => {
      console.error("[TestAgent]  ❌ postMessage failed", error)
    })
  }

  public async appendReviewComments(comments: unknown[], autoSend = false): Promise<void> {
    this.pendingReviewComments.push({ comments, autoSend })

    if (!this.webview) {
      await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
    }

    this.flushPendingReviewComments()
  }

  private flushPendingReviewComments(): void {
    if (!this.webview || !this.isWebviewReady || this.pendingReviewComments.length === 0) return

    const pending = this.pendingReviewComments
    this.pendingReviewComments = []

    for (const entry of pending) {
      this.postMessage({ type: "appendReviewComments", comments: entry.comments, autoSend: entry.autoSend })
    }
  }

  /**
   * Get the git remote URL for the current workspace using VS Code's built-in Git API.
   * Returns undefined if not in a git repo or no remotes are configured.
   */
  private async getGitRemoteUrl(): Promise<string | undefined> {
    try {
      const extension = vscode.extensions.getExtension("vscode.git")
      if (!extension) return undefined
      const api = extension.isActive ? extension.exports?.getAPI(1) : (await extension.activate())?.getAPI(1)
      if (!api) return undefined
      const repo = api.repositories?.[0]
      if (!repo) return undefined
      const remote = repo.state?.remotes?.find((r: { name: string }) => r.name === "origin")
      return remote?.fetchUrl ?? remote?.pushUrl
    } catch (error) {
      console.warn("[TestAgent]  Failed to get git remote URL:", error)
      return undefined
    }
  }

  /**
   * Gather VS Code editor context to send alongside messages to the CLI backend.
   */
  /**
   * Return the set of relative paths for all open text-editor tabs within the
   * given directory, filtered through .testagentignore. // testagent_change
   */
  private async getOpenTabPaths(dir: string): Promise<Set<string>> {
    const controller = await this.getIgnoreController(dir)
    const result = new Set<string>()
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri
          if (uri.scheme === "file") {
            const rel = path.relative(dir, uri.fsPath)
            if (!rel.startsWith("..") && !path.isAbsolute(rel) && controller.validateAccess(uri.fsPath)) {
              result.add(rel.replaceAll("\\", "/"))
            }
          }
        }
      }
    }
    return result
  }

  /**
   * Get or create a FileIgnoreController for the current workspace directory.
   * Reinitializes if the workspace directory has changed.
   */
  private async getIgnoreController(workspaceDir: string): Promise<FileIgnoreController> {
    if (this.ignoreController && this.ignoreControllerDir === workspaceDir) {
      return this.ignoreController
    }
    const controller = new FileIgnoreController(workspaceDir)
    await controller.initialize()
    this.ignoreController = controller
    this.ignoreControllerDir = workspaceDir
    return controller
  }

  private async gatherEditorContext(): Promise<EditorContext> {
    console.log("[TestAgent] 🎯 gatherEditorContext called")
    const workspaceDir = this.getWorkspaceDirectory()
    console.log("[TestAgent] 📁 Workspace directory:", workspaceDir)
    const controller = await this.getIgnoreController(workspaceDir)

    const toRelative = (fsPath: string): string | undefined => {
      if (!workspaceDir) {
        return undefined
      }
      const relative = path.relative(workspaceDir, fsPath)
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return undefined
      }
      return relative
    }

    // Visible files (capped to avoid bloating context, filtered through .testagentignore) // testagent_change
    const visibleFiles = vscode.window.visibleTextEditors
      .map((e) => e.document.uri)
      .filter((uri) => uri.scheme === "file")
      .map((uri) => toRelative(uri.fsPath))
      .filter((p): p is string => p !== undefined && controller.validateAccess(path.resolve(workspaceDir, p)))
      .slice(0, 200)
    console.log("[TestAgent] 👀 Visible files:", visibleFiles)

    // Open tabs — use instanceof TabInputText to exclude notebooks, diffs, custom editors
    const openTabs = [...(await this.getOpenTabPaths(workspaceDir))].slice(0, 20)
    console.log("[TestAgent] 📑 Open tabs:", openTabs)

    // Active file (also filtered through .testagentignore) // testagent_change
    const activeEditor = vscode.window.activeTextEditor
    const activeRel =
      activeEditor?.document.uri.scheme === "file" ? toRelative(activeEditor.document.uri.fsPath) : undefined
    const activeFile = activeRel && controller.validateAccess(activeEditor!.document.uri.fsPath) ? activeRel : undefined
    console.log("[TestAgent] ✏️ Active file:", activeFile)

    // Shell
    const shell = vscode.env.shell || undefined
    console.log("[TestAgent] 🐚 Shell:", shell)

    const result = {
      ...(visibleFiles.length > 0 ? { visibleFiles } : {}),
      ...(openTabs.length > 0 ? { openTabs } : {}),
      ...(activeFile ? { activeFile } : {}),
      ...(shell ? { shell } : {}),
    }

    console.log("[TestAgent] 📦 Final EditorContext:", JSON.stringify(result, null, 2))

    return result
  }

  /**
   * Get the workspace directory for a session.
   * Checks session directory overrides first (e.g., worktree paths), then falls back to workspace root.
   */
  private getWorkspaceDirectory(sessionId?: string): string {
    return resolveWorkspaceDirectory({
      sessionID: sessionId,
      sessionDirectories: this.sessionDirectories,
      workspaceDirectory: this.getRootDirectory(),
    })
  }

  private getContextDirectory(): string {
    return resolveContextDirectory({
      currentSessionID: this.currentSession?.id,
      contextSessionID: this.contextSessionID,
      sessionDirectories: this.sessionDirectories,
      workspaceDirectory: this.getRootDirectory(),
    })
  }

  private getRootDirectory(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0]!.uri.fsPath
    }
    return process.cwd()
  }

  private trackDirectory(sessionId: string, dir: string) {
    if (path.resolve(dir) === path.resolve(this.getRootDirectory())) {
      this.sessionDirectories.delete(sessionId)
      return
    }
    this.sessionDirectories.set(sessionId, dir)
  }

  private noteFollowup(answers: string[][], sessionID?: string) {
    const dir = this.getWorkspaceDirectory(sessionID)
    this.pendingFollowup = recordFollowup({ answers, dir, now: Date.now() }) ?? null
  }

  private matchesPendingFollowup(session: Session) {
    return matchFollowup({ pending: this.pendingFollowup, dir: session.directory, now: Date.now() })
  }

  private adoptPendingFollowup(session: Session) {
    const now = Date.now()
    const match = this.matchesPendingFollowup(session)
    if (!match) {
      if (
        this.pendingFollowup &&
        !matchFollowup({ pending: this.pendingFollowup, dir: this.pendingFollowup.dir, now })
      ) {
        this.pendingFollowup = null
      }
      return false
    }

    this.pendingFollowup = null
    this.trackDirectory(session.id, session.directory)
    for (const cb of this.followupListeners) cb(session, session.directory)
    this.registerSession(session)
    void this.handleLoadMessages(session.id)
    return true
  }

  private getProjectDirectory(sessionId?: string): string | undefined {
    return resolveProjectDirectory(this.projectDirectory, () => this.getWorkspaceDirectory(sessionId))
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")),
      iconsBaseUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "icons")),
      title: "TestAgent",
      port: this.connectionService.getServerInfo()?.port,
      extraStyles: `.container { height: 100%; display: flex; flex-direction: column; height: 100vh; border-right: 1px solid var(--border-weak-base); }`,
    })
  }

  // legacy-migration start -------------------------------------------------------
  // Migration handlers extracted to kilo-provider/handlers/migration.ts

  private get migrationCtx(): MigrationContext {
    const self = this
    return {
      client: this.client,
      extensionContext: this.extensionContext,
      postMessage: (msg) => this.postMessage(msg),
      get cachedLegacyData() {
        return self.cachedLegacyData
      },
      set cachedLegacyData(data) {
        self.cachedLegacyData = data
      },
      get migrationCheckInFlight() {
        return self.migrationCheckInFlight
      },
      set migrationCheckInFlight(val) {
        self.migrationCheckInFlight = val
      },
      refreshSessions: () => this.refreshSessions(),
      disposeGlobal: () => this.disposeGlobal(),
      broadcastComplete: () => this.connectionService.notifyMigrationComplete(),
    }
  }

  // legacy-migration end ---------------------------------------------------------

  private getMarketplace(): MarketplaceService {
    if (this.marketplace) return this.marketplace
    this.marketplace = new MarketplaceService()
    return this.marketplace
  }

  // ── Worktree stats polling (sidebar diff badge) ──────────────────

  private startStatsPolling(): void {
    this.statsPoller?.stop()
    this.statsGitOps?.dispose()
    const git = new GitOps({ log: () => {} })
    this.statsGitOps = git
    this.statsPoller = new GitStatsPoller({
      getWorktrees: () => [],
      getWorkspaceRoot: () => getWorkspaceRoot(),
      localDiff: (dir, base) => localDiffSummary(git, dir, base),
      git,
      onStats: () => {},
      onLocalStats: (stats: LocalStats) => {
        const msg = {
          type: "worktreeStatsLoaded" as const,
          files: stats.files,
          additions: stats.additions,
          deletions: stats.deletions,
        }
        this.cachedStats = msg
        this.postMessage(msg)
      },
      log: () => {},
      hiddenIntervalMs: 60000,
    })
    this.statsPoller.setEnabled(true)
    this.statsPoller.setVisible(true)
  }

  /**
   * Dispose of the provider and clean up subscriptions.
   * Does NOT kill the server — that's the connection service's job.
   */
  dispose(): void {
    this.unsubscribeRemote?.()
    this.focusSession()
    this.statsPoller?.stop()
    this.statsGitOps?.dispose()
    this.unsubscribeEvent?.()
    this.unsubscribeState?.()
    this.unsubscribeNotificationDismiss?.()
    this.unsubscribeLanguageChange?.()
    this.unsubscribeProfileChange?.()
    this.unsubscribeFavoritesChange?.()
    this.unsubscribeMigrationComplete?.()
    this.unsubscribeClearPendingPrompts?.()
    this.unsubscribeAgentsChange?.() // testagent_change
    this.unsubscribeDirectoryProvider?.()
    this.viewStateDisposable?.dispose()
    this.visibilityDisposable?.dispose()
    this.webviewMessageDisposable?.dispose()
    this.streams.dispose()
    this.isWebviewReady = false
    this.promptRecoveryQueued = false
    clearNetworkWaits(this.trackedSessionIds)
    this.trackedSessionIds.clear()
    // syncedChildSessions, parentWithChildren, childToParent are module-level
    // (shared across KiloProvider instances) — not cleared here to avoid
    // breaking other instances that still reference them.
    this.sessionDirectories.clear()
    this.sessionStatusMap.clear()
    this.ignoreController?.dispose()
    this.chatAutocomplete?.dispose()
    this.marketplace?.dispose()
  }

  private async resolveShell(name: string): Promise<string | null> {
    if (process.platform === "win32" && name === "bash") {
      const candidates = [
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files (x86)/Git/bin/bash.exe",
        "C:/Program Files/Git/usr/bin/bash.exe",
      ]
      for (const f of candidates) {
        if (fs.existsSync(f)) return f
      }
      try {
        const { stdout } = await exec("where", ["bash"])
        return (stdout.trim().split("\n")[0] || null)?.replace(/\\/g, "/") ?? null
      } catch {}
      return null
    }
    const which = process.platform === "win32" ? "where" : "which"
    try {
      const { stdout } = await exec(which, [name])
      return (stdout.trim().split("\n")[0] || null)?.replace(/\\/g, "/") ?? null
    } catch {}
    return null
  }

  private async checkGitInstalled(): Promise<boolean> {
    try {
      await exec("git", ["--version"])
      return true
    } catch {
      return false
    }
  }

  // testagent_change start - detect available terminals on the current system
  private async getAvailableTerminals(): Promise<Array<{ name: string; path: string; description?: string }>> {
    const result: Array<{ name: string; path: string; description?: string }> = []
    const platform = process.platform

    if (platform === "win32") {
      // PowerShell
      const psPaths = [
        "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        "C:/Windows/System32/powershell.exe",
      ]
      for (const p of psPaths) {
        if (fs.existsSync(p)) {
          result.push({ name: "PowerShell", path: p, description: "Windows PowerShell" })
          break
        }
      }

      // PowerShell 7+
      const ps7Paths = [
        "C:/Program Files/PowerShell/7/pwsh.exe",
        "C:/Program Files (x86)/PowerShell/7/pwsh.exe",
      ]
      for (const p of ps7Paths) {
        if (fs.existsSync(p)) {
          result.push({ name: "PowerShell 7", path: p, description: "PowerShell Core 7+" })
          break
        }
      }

      // CMD
      const cmdPath = "C:/Windows/System32/cmd.exe"
      if (fs.existsSync(cmdPath)) {
        result.push({ name: "CMD", path: cmdPath, description: "Windows Command Prompt" })
      }

      // Git Bash
      const gitBashPaths = [
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files (x86)/Git/bin/bash.exe",
        "C:/Program Files/Git/usr/bin/bash.exe",
      ]
      for (const p of gitBashPaths) {
        if (fs.existsSync(p)) {
          result.push({ name: "Git Bash", path: p, description: "Git for Windows Bash" })
          break
        }
      }

      // WSL
      const wslPath = "C:/Windows/System32/wsl.exe"
      if (fs.existsSync(wslPath)) {
        result.push({ name: "WSL", path: wslPath, description: "Windows Subsystem for Linux" })
      }
    } else {
      // macOS / Linux — read available shells from /etc/shells
      try {
        const content = fs.readFileSync("/etc/shells", "utf-8")
        const shells = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
        for (const shellPath of shells) {
          if (fs.existsSync(shellPath)) {
            const name = shellPath.split("/").pop() || shellPath
            result.push({ name, path: shellPath, description: `System shell (${shellPath})` })
          }
        }
      } catch {
        // Fallback: common shells
        const common = ["/bin/bash", "/bin/zsh", "/bin/sh", "/bin/tcsh", "/bin/ksh"]
        for (const shellPath of common) {
          if (fs.existsSync(shellPath)) {
            const name = shellPath.split("/").pop() || shellPath
            result.push({ name, path: shellPath })
          }
        }
      }

      // macOS terminal apps
      if (platform === "darwin") {
        const terminalApps = [
          { name: "Terminal.app", path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
          { name: "iTerm2", path: "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
        ]
        for (const app of terminalApps) {
          if (fs.existsSync(app.path)) {
            result.push({ ...app, description: "macOS terminal emulator" })
          }
        }
      }
    }

    return result
  }
  // testagent_change end
}
