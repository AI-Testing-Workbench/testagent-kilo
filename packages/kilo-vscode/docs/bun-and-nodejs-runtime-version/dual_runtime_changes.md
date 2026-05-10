# 双运行时实现 — 变更总结

## 已完成的变更

### 新增文件 (3)

| 文件 | 用途 |
|------|------|
| [runtime.ts](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/src/services/cli-backend/runtime.ts) | 编译时常量声明 + `isTestagentBun()` / `isTestagentNodejs()` 工具函数 |
| [node-server-manager.ts](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/src/services/cli-backend/node-server-manager.ts) | Node.js 进程管理器，spawn `node --experimental-sqlite cli.mjs` |
| [package-nodejs-server.ts](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/script/package-nodejs-server.ts) | Node.js 服务器版本打包脚本 |

### 修改文件 (5)

#### 1. [esbuild.js](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/esbuild.js)
```diff:esbuild.js
const esbuild = require("esbuild")
const path = require("path")
const { solidPlugin } = require("esbuild-plugin-solid")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/**
 * Force all solid-js imports (from kilo-ui and the webview) to resolve to
 * the **same** copy so SolidJS contexts are shared across packages.
 * Without this, the monorepo hoists separate copies (pnpm vs bun) and
 * createContext / useContext can't see each other.
 *
 * @type {import('esbuild').Plugin}
 */
const solidDedupePlugin = {
  name: "solid-dedupe",
  setup(build) {
    // Resolve these bare specifiers to the kilo-vscode-local copy
    const solidRoot = path.dirname(require.resolve("solid-js/package.json"))
    const aliases = {
      "solid-js": path.join(solidRoot, "dist", "solid.js"),
      "solid-js/web": path.join(solidRoot, "web", "dist", "web.js"),
      "solid-js/store": path.join(solidRoot, "store", "dist", "store.js"),
    }

    build.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => {
      const key = args.path
      if (aliases[key]) {
        return { path: aliases[key] }
      }
    })
  },
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`)
        }
      })
      console.log("[watch] build finished")
    })
  },
}

/**
 * testagent_change start: Force jsonc-parser to use ESM version to avoid CommonJS require issues
 * @type {import('esbuild').Plugin}
 */
const jsoncParserEsmPlugin = {
  name: "jsonc-parser-esm",
  setup(build) {
    // Redirect jsonc-parser imports to use the ESM version
    build.onResolve({ filter: /^jsonc-parser$/ }, (args) => {
      const jsoncPath = require.resolve("jsonc-parser")
      const esmPath = jsoncPath.replace(/lib[\/\\]umd[\/\\]main\.js$/, "lib/esm/main.js")
      return { path: esmPath }
    })
  },
}
// testagent_change end

/**
 * Stub the pierre worker module so the Diff/Code components work without
 * web workers in the VS Code webview. The `@pierre/diffs` library handles
 * undefined worker pools gracefully (renders without syntax highlighting).
 *
 * We stub the entire worker module rather than just the URL import because
 * `new Worker('')` would throw at runtime.
 *
 * @type {import('esbuild').Plugin}
 */
const pierreWorkerStubPlugin = {
  name: "pierre-worker-stub",
  setup(build) {
    // Stub the Vite-specific ?worker&url import
    build.onResolve({ filter: /\?worker&url$/ }, (args) => ({
      path: args.path,
      namespace: "worker-url-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "worker-url-stub" }, () => ({
      contents: "export default ''",
      loader: "js",
    }))

    // Stub the pierre worker module so getWorkerPool always returns undefined
    build.onResolve({ filter: /pierre\/worker$/ }, (args) => {
      // Only stub the local UI worker module, not @pierre/diffs/worker
      if (args.path.includes("@pierre")) return
      return {
        path: args.path,
        namespace: "pierre-worker-stub",
      }
    })
    build.onLoad({ filter: /.*/, namespace: "pierre-worker-stub" }, () => ({
      contents: `
        export function getWorkerPool() { return undefined }
        export function getWorkerPools() { return { unified: undefined, split: undefined } }
        export function workerFactory() { return undefined }
      `,
      loader: "js",
    }))
  },
}

const svgSpritePlugin = {
  name: "svg-sprite-inline",
  setup(build) {
    build.onLoad({ filter: /sprite\.svg$/ }, (args) => {
      const content = require("fs").readFileSync(args.path, "utf8")
      return {
        contents: `
          const svg = ${JSON.stringify(content)};
          const inject = () => {
            if (!document.getElementById("kilo-sprite")) {
              const el = document.createElement("div");
              el.id = "kilo-sprite";
              el.style.display = "none";
              el.innerHTML = svg;
              document.body.appendChild(el);
            }
          };
          if (document.body) inject();
          else document.addEventListener("DOMContentLoaded", inject);
          export default "";
        `,
        loader: "js",
      }
    })
  },
}

const cssPackageResolvePlugin = {
  name: "css-package-resolve",
  setup(build) {
    build.onResolve({ filter: /^@/, namespace: "file" }, (args) => {
      if (args.kind === "import-rule") {
        return build.resolve(args.path, {
          kind: "import-statement",
          resolveDir: args.resolveDir,
        })
      }
    })
  },
}

function createBrowserWebviewContext(entryPoint, outfile) {
  return esbuild.context({
    entryPoints: [entryPoint],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile,
    logLevel: "silent",
    loader: {
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
    },
    plugins: [
      solidDedupePlugin,
      pierreWorkerStubPlugin,
      svgSpritePlugin,
      cssPackageResolvePlugin,
      solidPlugin(),
      esbuildProblemMatcherPlugin,
    ],
  })
}

async function main() {
  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"], // testagent_change: only vscode is external, bundle everything else including jsonc-parser
    logLevel: "silent",
    // testagent_change start: ensure proper CommonJS handling for jsonc-parser
    mainFields: ["module", "main"],
    conditions: ["node"],
    plugins: [jsoncParserEsmPlugin, esbuildProblemMatcherPlugin], // testagent_change: add jsonc-parser ESM plugin
    // testagent_change end
  })

  // Build Agent Manager webview (SolidJS, shares components with sidebar)
  const agentManagerCtx = await createBrowserWebviewContext(
    "webview-ui/agent-manager/index.tsx",
    "dist/agent-manager.js",
  )

  // Build KiloClaw webview (SolidJS, standalone chat panel)
  const kiloClawCtx = await createBrowserWebviewContext("webview-ui/kiloclaw/index.tsx", "dist/kiloclaw.js")

  // Build Diff Viewer webview (SolidJS, reuses Agent Manager diff components)
  const diffViewerCtx = await createBrowserWebviewContext("webview-ui/diff-viewer/index.tsx", "dist/diff-viewer.js")

  // Build Diff Virtual webview (lightweight single-file diff for permission approval)
  const diffVirtualCtx = await createBrowserWebviewContext("webview-ui/diff-virtual/index.tsx", "dist/diff-virtual.js")

  // Build webview
  const webviewCtx = await createBrowserWebviewContext("webview-ui/src/index.tsx", "dist/webview.js")

  if (watch) {
    await Promise.all([
      extensionCtx.watch(),
      webviewCtx.watch(),
      agentManagerCtx.watch(),
      diffViewerCtx.watch(),
      diffVirtualCtx.watch(),
      kiloClawCtx.watch(),
    ])
  } else {
    await Promise.all([
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
      agentManagerCtx.rebuild(),
      kiloClawCtx.rebuild(),
      diffViewerCtx.rebuild(),
      diffVirtualCtx.rebuild(),
    ])
    await Promise.all([
      extensionCtx.dispose(),
      webviewCtx.dispose(),
      agentManagerCtx.dispose(),
      kiloClawCtx.dispose(),
      diffViewerCtx.dispose(),
      diffVirtualCtx.dispose(),
    ])
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
===
const esbuild = require("esbuild")
const path = require("path")
const { solidPlugin } = require("esbuild-plugin-solid")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

// Backend runtime selection: "testagent" (Bun binary) or "opencode" (Node.js)
// Set via BACKEND_RUNTIME env var at build time. Defaults to "testagent".
const backendRuntime = process.env.BACKEND_RUNTIME || "testagent"
console.log(`[build] Backend runtime: ${backendRuntime}`)

/**
 * Force all solid-js imports (from kilo-ui and the webview) to resolve to
 * the **same** copy so SolidJS contexts are shared across packages.
 * Without this, the monorepo hoists separate copies (pnpm vs bun) and
 * createContext / useContext can't see each other.
 *
 * @type {import('esbuild').Plugin}
 */
const solidDedupePlugin = {
  name: "solid-dedupe",
  setup(build) {
    // Resolve these bare specifiers to the kilo-vscode-local copy
    const solidRoot = path.dirname(require.resolve("solid-js/package.json"))
    const aliases = {
      "solid-js": path.join(solidRoot, "dist", "solid.js"),
      "solid-js/web": path.join(solidRoot, "web", "dist", "web.js"),
      "solid-js/store": path.join(solidRoot, "store", "dist", "store.js"),
    }

    build.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => {
      const key = args.path
      if (aliases[key]) {
        return { path: aliases[key] }
      }
    })
  },
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started")
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`)
        }
      })
      console.log("[watch] build finished")
    })
  },
}

/**
 * testagent_change start: Force jsonc-parser to use ESM version to avoid CommonJS require issues
 * @type {import('esbuild').Plugin}
 */
const jsoncParserEsmPlugin = {
  name: "jsonc-parser-esm",
  setup(build) {
    // Redirect jsonc-parser imports to use the ESM version
    build.onResolve({ filter: /^jsonc-parser$/ }, (args) => {
      const jsoncPath = require.resolve("jsonc-parser")
      const esmPath = jsoncPath.replace(/lib[\/\\]umd[\/\\]main\.js$/, "lib/esm/main.js")
      return { path: esmPath }
    })
  },
}
// testagent_change end

/**
 * Stub the pierre worker module so the Diff/Code components work without
 * web workers in the VS Code webview. The `@pierre/diffs` library handles
 * undefined worker pools gracefully (renders without syntax highlighting).
 *
 * We stub the entire worker module rather than just the URL import because
 * `new Worker('')` would throw at runtime.
 *
 * @type {import('esbuild').Plugin}
 */
const pierreWorkerStubPlugin = {
  name: "pierre-worker-stub",
  setup(build) {
    // Stub the Vite-specific ?worker&url import
    build.onResolve({ filter: /\?worker&url$/ }, (args) => ({
      path: args.path,
      namespace: "worker-url-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "worker-url-stub" }, () => ({
      contents: "export default ''",
      loader: "js",
    }))

    // Stub the pierre worker module so getWorkerPool always returns undefined
    build.onResolve({ filter: /pierre\/worker$/ }, (args) => {
      // Only stub the local UI worker module, not @pierre/diffs/worker
      if (args.path.includes("@pierre")) return
      return {
        path: args.path,
        namespace: "pierre-worker-stub",
      }
    })
    build.onLoad({ filter: /.*/, namespace: "pierre-worker-stub" }, () => ({
      contents: `
        export function getWorkerPool() { return undefined }
        export function getWorkerPools() { return { unified: undefined, split: undefined } }
        export function workerFactory() { return undefined }
      `,
      loader: "js",
    }))
  },
}

const svgSpritePlugin = {
  name: "svg-sprite-inline",
  setup(build) {
    build.onLoad({ filter: /sprite\.svg$/ }, (args) => {
      const content = require("fs").readFileSync(args.path, "utf8")
      return {
        contents: `
          const svg = ${JSON.stringify(content)};
          const inject = () => {
            if (!document.getElementById("kilo-sprite")) {
              const el = document.createElement("div");
              el.id = "kilo-sprite";
              el.style.display = "none";
              el.innerHTML = svg;
              document.body.appendChild(el);
            }
          };
          if (document.body) inject();
          else document.addEventListener("DOMContentLoaded", inject);
          export default "";
        `,
        loader: "js",
      }
    })
  },
}

const cssPackageResolvePlugin = {
  name: "css-package-resolve",
  setup(build) {
    build.onResolve({ filter: /^@/, namespace: "file" }, (args) => {
      if (args.kind === "import-rule") {
        return build.resolve(args.path, {
          kind: "import-statement",
          resolveDir: args.resolveDir,
        })
      }
    })
  },
}

function createBrowserWebviewContext(entryPoint, outfile) {
  return esbuild.context({
    entryPoints: [entryPoint],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile,
    logLevel: "silent",
    loader: {
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
    },
    plugins: [
      solidDedupePlugin,
      pierreWorkerStubPlugin,
      svgSpritePlugin,
      cssPackageResolvePlugin,
      solidPlugin(),
      esbuildProblemMatcherPlugin,
    ],
  })
}

async function main() {
  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"], // testagent_change: only vscode is external, bundle everything else including jsonc-parser
    logLevel: "silent",
    // Inject compile-time backend runtime constant for dual-build support
    define: {
      BACKEND_RUNTIME: JSON.stringify(backendRuntime),
    },
    // testagent_change start: ensure proper CommonJS handling for jsonc-parser
    mainFields: ["module", "main"],
    conditions: ["node"],
    plugins: [jsoncParserEsmPlugin, esbuildProblemMatcherPlugin], // testagent_change: add jsonc-parser ESM plugin
    // testagent_change end
  })

  // Build Agent Manager webview (SolidJS, shares components with sidebar)
  const agentManagerCtx = await createBrowserWebviewContext(
    "webview-ui/agent-manager/index.tsx",
    "dist/agent-manager.js",
  )

  // Build KiloClaw webview (SolidJS, standalone chat panel)
  const kiloClawCtx = await createBrowserWebviewContext("webview-ui/kiloclaw/index.tsx", "dist/kiloclaw.js")

  // Build Diff Viewer webview (SolidJS, reuses Agent Manager diff components)
  const diffViewerCtx = await createBrowserWebviewContext("webview-ui/diff-viewer/index.tsx", "dist/diff-viewer.js")

  // Build Diff Virtual webview (lightweight single-file diff for permission approval)
  const diffVirtualCtx = await createBrowserWebviewContext("webview-ui/diff-virtual/index.tsx", "dist/diff-virtual.js")

  // Build webview
  const webviewCtx = await createBrowserWebviewContext("webview-ui/src/index.tsx", "dist/webview.js")

  if (watch) {
    await Promise.all([
      extensionCtx.watch(),
      webviewCtx.watch(),
      agentManagerCtx.watch(),
      diffViewerCtx.watch(),
      diffVirtualCtx.watch(),
      kiloClawCtx.watch(),
    ])
  } else {
    await Promise.all([
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
      agentManagerCtx.rebuild(),
      kiloClawCtx.rebuild(),
      diffViewerCtx.rebuild(),
      diffVirtualCtx.rebuild(),
    ])
    await Promise.all([
      extensionCtx.dispose(),
      webviewCtx.dispose(),
      agentManagerCtx.dispose(),
      kiloClawCtx.dispose(),
      diffViewerCtx.dispose(),
      diffVirtualCtx.dispose(),
    ])
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- 读取 `BACKEND_RUNTIME` 环境变量（默认 `"testagent-bun"`）
- 通过 `define: { BACKEND_RUNTIME: ... }` 注入编译时常量
- esbuild 会在 minify 时自动消除死代码

#### 2. [connection-service.ts](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/src/services/cli-backend/connection-service.ts)
```diff:connection-service.ts
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { createKiloClient, type KiloClient, type Event } from "@kilocode/sdk/v2/client"
import { SdkSSEAdapter } from "./sdk-sse-adapter"
import type { ServerConfig } from "./types"
import { resolveEventSessionId as resolveEventSessionIdPure } from "./connection-utils"

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error"
type SSEEventListener = (event: Event) => void
type StateListener = (state: ConnectionState) => void
type SSEEventFilter = (event: Event) => boolean
type NotificationDismissListener = (notificationId: string) => void
type LanguageChangeListener = (locale: string) => void
type ProfileChangeListener = (data: unknown) => void
type MigrationCompleteListener = () => void
type FavoritesChangeListener = (favorites: Array<{ providerID: string; modelID: string }>) => void
type ClearPendingPromptsListener = () => void
type DirectoryProvider = () => string[]

// Poll /global/health at the same interval as packages/app/src/context/server.tsx.
// This provides a second detection channel for server death independent of the SSE heartbeat.
const HEALTH_POLL_INTERVAL_MS = 10_000

/**
 * Reject all pending network-offline waits for a given directory.
 * The network namespace is not yet in the SDK KiloClient type (pending SDK regeneration),
 * so we access it via a type assertion.
 */
async function drainNetworkWaits(client: KiloClient, dir: string) {
  const net = (client as any).network as
    | {
        list: (p: { directory: string }) => Promise<{ data?: { id: string }[]; error?: unknown }>
        reject: (p: { requestID: string; directory: string }) => Promise<{ error?: unknown }>
      }
    | undefined
  if (!net) return
  const { data: waits, error: err } = await net.list({ directory: dir })
  if (err) throw new Error(`Failed to list network waits for ${dir}: ${String(err)}`)
  if (!waits) return
  for (const w of waits) {
    const { error } = await net.reject({ requestID: w.id, directory: dir })
    if (error) throw new Error(`Failed to reject network wait ${w.id}: ${String(error)}`)
  }
}

/**
 * Shared connection service that owns the single ServerManager, KiloClient (SDK), and SdkSSEAdapter.
 * Multiple KiloProvider instances subscribe to it for SSE events and state changes.
 */
export class KiloConnectionService {
  private readonly serverManager: ServerManager
  private client: KiloClient | null = null
  private sseClient: SdkSSEAdapter | null = null
  private info: { port: number } | null = null
  private config: ServerConfig | null = null
  private state: ConnectionState = "disconnected"
  private connectPromise: Promise<void> | null = null
  private healthPollTimer: ReturnType<typeof setInterval> | null = null
  private remoteService: import("../RemoteStatusService").RemoteStatusService | null = null

  private readonly eventListeners: Set<SSEEventListener> = new Set()
  private readonly stateListeners: Set<StateListener> = new Set()
  private readonly notificationDismissListeners: Set<NotificationDismissListener> = new Set()
  private readonly languageChangeListeners: Set<LanguageChangeListener> = new Set()
  private readonly profileChangeListeners: Set<ProfileChangeListener> = new Set()
  private readonly migrationCompleteListeners: Set<MigrationCompleteListener> = new Set()
  private readonly favoritesChangeListeners: Set<FavoritesChangeListener> = new Set()
  private readonly clearPendingPromptsListeners: Set<ClearPendingPromptsListener> = new Set()
  private readonly directoryProviders: Set<DirectoryProvider> = new Set()

  /**
   * Shared mapping used to resolve session scope for events that don't reliably include a sessionID.
   * Used primarily for message.part.updated where only messageID may be present.
   */
  private readonly messageSessionIdsByMessageId: Map<string, string> = new Map()

  /** Provider key → single focused session ID. */
  private readonly focused: Map<string, string> = new Map()
  /** Provider key → all open (background) session IDs. */
  private readonly opened: Map<string, string[]> = new Map()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private unsubRemote: (() => void) | null = null

  constructor(context: vscode.ExtensionContext) {
    this.serverManager = new ServerManager(context)
    // testagent_change start - sync user ID to CLI whenever auth session changes
    context.subscriptions.push(
      vscode.authentication.onDidChangeSessions(async (e) => {
        if (e.provider.id === "tscode-oauth") {
          await this.syncUserId()
        }
      }),
    )
    // testagent_change end
  }

  /**
   * Lazily start server + SSE. Multiple callers share the same promise.
   */
  async connect(workspaceDir: string): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise
    }
    if (this.state === "connected") {
      return
    }

    // Mark as connecting early so concurrent callers won't start another connection attempt.
    this.setState("connecting")

    this.connectPromise = this.doConnect(workspaceDir)
    try {
      await this.connectPromise
    } catch (error) {
      // If doConnect() fails before SSE can emit a state transition, avoid leaving consumers stuck in "connecting".
      this.setState("error")
      throw error
    } finally {
      this.connectPromise = null
    }
  }

  /**
   * Get the shared SDK client. Throws if not connected.
   */
  getClient(): KiloClient {
    if (!this.client) {
      throw new Error("Not connected — call connect() first")
    }
    return this.client
  }

  /**
   * Get the shared SDK client, auto-connecting if not yet started.
   * Accepts an optional directory to use as the workspace root; falls back
   * to the first VS Code workspace folder. Throws if neither is available
   * or if the connection fails.
   */
  async getClientAsync(dir?: string): Promise<KiloClient> {
    if (this.client) return this.client
    const root = dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) throw new Error("No workspace folder open")
    await this.connect(root)
    return this.client!
  }

  /**
   * Get server info (port). Returns null if not connected.
   */
  getServerInfo(): { port: number } | null {
    return this.info
  }

  /**
   * Get server config (baseUrl + password). Returns null if not connected.
   * Used by TelemetryProxy to POST events to the CLI server.
   */
  getServerConfig(): ServerConfig | null {
    return this.config
  }

  /**
   * Set the remote status service. When remote is disabled, flushViewed()
   * is a no-op. When remote becomes enabled (startup refresh, user toggle,
   * or SSE event), the accumulated focused/opened state is automatically
   * flushed so the server is never left unaware of already-open sessions.
   */
  setRemoteService(service: import("../RemoteStatusService").RemoteStatusService | null): void {
    this.unsubRemote?.()
    this.unsubRemote = null
    this.remoteService = service
    if (service) {
      this.unsubRemote = service.onChange((state) => {
        if (state.enabled) this.flushViewed()
      })
    }
  }

  private isRemoteEnabled(): boolean {
    return this.remoteService?.getState().enabled ?? false
  }

  /**
   * Current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.state
  }

  /**
   * Subscribe to SSE events. Returns unsubscribe function.
   */
  onEvent(listener: SSEEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Subscribe to SSE events with a filter. The filter runs for every incoming SSE event.
   */
  onEventFiltered(filter: SSEEventFilter, listener: SSEEventListener): () => void {
    const wrapped: SSEEventListener = (event) => {
      if (!filter(event)) {
        return
      }
      listener(event)
    }
    return this.onEvent(wrapped)
  }

  /**
   * Record a messageID -> sessionID mapping, typically from message.updated or from HTTP message history.
   */
  recordMessageSessionId(messageId: string, sessionId: string): void {
    if (!messageId || !sessionId) {
      return
    }
    this.messageSessionIdsByMessageId.set(messageId, sessionId)
  }

  /**
   * Remove all messageID → sessionID entries for a given session.
   * Called when a session is deleted or otherwise pruned so the map
   * does not grow unbounded over the extension lifetime.
   */
  pruneSession(sessionId: string): void {
    for (const [mid, sid] of this.messageSessionIdsByMessageId) {
      if (sid === sessionId) this.messageSessionIdsByMessageId.delete(mid)
    }
  }

  /**
   * Best-effort sessionID extraction for an SSE event.
   * Returns undefined for global events.
   */
  resolveEventSessionId(event: Event): string | undefined {
    return resolveEventSessionIdPure(
      event,
      (messageId) => this.messageSessionIdsByMessageId.get(messageId),
      (messageId, sessionId) => this.recordMessageSessionId(messageId, sessionId),
    )
  }

  /**
   * Subscribe to notification dismiss events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onNotificationDismissed(listener: NotificationDismissListener): () => void {
    this.notificationDismissListeners.add(listener)
    return () => {
      this.notificationDismissListeners.delete(listener)
    }
  }

  /**
   * Broadcast a notification dismiss event to all subscribed KiloProvider instances.
   */
  notifyNotificationDismissed(notificationId: string): void {
    for (const listener of this.notificationDismissListeners) {
      listener(notificationId)
    }
  }

  /**
   * Subscribe to language change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onLanguageChanged(listener: LanguageChangeListener): () => void {
    this.languageChangeListeners.add(listener)
    return () => {
      this.languageChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a language change event to all subscribed KiloProvider instances.
   */
  notifyLanguageChanged(locale: string): void {
    for (const listener of this.languageChangeListeners) {
      listener(locale)
    }
  }

  /**
   * Subscribe to profile change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onProfileChanged(listener: ProfileChangeListener): () => void {
    this.profileChangeListeners.add(listener)
    return () => {
      this.profileChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a profile change event to all subscribed KiloProvider instances.
   */
  notifyProfileChanged(data: unknown): void {
    for (const listener of this.profileChangeListeners) {
      listener(data)
    }
  }

  /**
   * Subscribe to migration-complete events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onMigrationComplete(listener: MigrationCompleteListener): () => void {
    this.migrationCompleteListeners.add(listener)
    return () => {
      this.migrationCompleteListeners.delete(listener)
    }
  }

  /**
   * Broadcast a migration-complete event to all subscribed KiloProvider instances.
   */
  notifyMigrationComplete(): void {
    for (const listener of this.migrationCompleteListeners) {
      listener()
    }
  }

  /**
   * Subscribe to favorites change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onFavoritesChanged(listener: FavoritesChangeListener): () => void {
    this.favoritesChangeListeners.add(listener)
    return () => {
      this.favoritesChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a favorites change event to all subscribed KiloProvider instances.
   */
  notifyFavoritesChanged(favorites: Array<{ providerID: string; modelID: string }>): void {
    for (const listener of this.favoritesChangeListeners) {
      listener(favorites)
    }
  }

  /**
   * Subscribe to clear-pending-prompts broadcast. Returns unsubscribe function.
   * Fired after a config save drains all pending permissions/questions so each
   * webview can clear stale prompt UI.
   */
  onClearPendingPrompts(listener: ClearPendingPromptsListener): () => void {
    this.clearPendingPromptsListeners.add(listener)
    return () => {
      this.clearPendingPromptsListeners.delete(listener)
    }
  }

  /**
   * Register a callback that returns workspace directories tracked by a
   * KiloProvider (root + worktree dirs). Used by drainPendingPrompts() to
   * cover all active Instance directories across every provider.
   */
  registerDirectoryProvider(provider: DirectoryProvider): () => void {
    this.directoryProviders.add(provider)
    return () => {
      this.directoryProviders.delete(provider)
    }
  }

  /**
   * Reject all pending permission requests and questions across every
   * directory known to any KiloProvider **and** every project the CLI
   * backend has ever opened. The project list covers worktree sessions
   * whose provider was disposed (panel/sidebar closed) while the CLI
   * backend kept running.
   *
   * Must be called before operations that trigger Instance.disposeAll()
   * (e.g. config save) to prevent orphaned Promises from freezing
   * sessions.
   *
   * Throws if any list/reject call fails so callers can abort the
   * destructive operation.
   */
  async drainPendingPrompts(): Promise<void> {
    if (!this.client) return

    // Collect directories from all mounted providers (root + worktree dirs).
    const dirs = new Set<string>()
    for (const provider of this.directoryProviders) {
      for (const dir of provider()) {
        dirs.add(dir)
      }
    }

    // Also include every project directory the CLI backend knows about.
    // This covers worktree sessions whose KiloProvider was already disposed.
    const { data: projects, error: projectsErr } = await this.client.project.list()
    if (projectsErr) throw new Error(`Failed to list projects: ${String(projectsErr)}`)
    if (projects) {
      for (const p of projects) {
        dirs.add(p.worktree)
      }
    }

    for (const dir of dirs) {
      const { data: perms, error: permsErr } = await this.client.permission.list({ directory: dir })
      if (permsErr) throw new Error(`Failed to list permissions for ${dir}: ${String(permsErr)}`)
      if (perms) {
        for (const perm of perms) {
          const { error } = await this.client.permission.reply({ requestID: perm.id, reply: "reject", directory: dir })
          if (error) throw new Error(`Failed to reject permission ${perm.id}: ${String(error)}`)
        }
      }
      const { data: qs, error: qsErr } = await this.client.question.list({ directory: dir })
      if (qsErr) throw new Error(`Failed to list questions for ${dir}: ${String(qsErr)}`)
      if (qs) {
        for (const q of qs) {
          const { error } = await this.client.question.reject({ requestID: q.id, directory: dir })
          if (error) throw new Error(`Failed to reject question ${q.id}: ${String(error)}`)
        }
      }
      await drainSuggestions(this.client, dir)
      await drainNetworkWaits(this.client, dir)
    }
    for (const listener of this.clearPendingPromptsListeners) {
      listener()
    }
  }

  /**
   * Subscribe to connection state changes. Returns unsubscribe function.
   */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /**
   * Register the session a provider is actively viewing (focused).
   * After any change the aggregated set is sent to the server (debounced).
   */
  registerFocused(key: string, sessionID: string): void {
    if (this.focused.get(key) === sessionID) return
    this.focused.set(key, sessionID)
    this.flushViewed()
  }

  /**
   * Unregister a provider's focused session (e.g. on dispose, hidden, or clearSession).
   */
  unregisterFocused(key: string): void {
    if (!this.focused.has(key)) return
    this.focused.delete(key)
    this.flushViewed()
  }

  /**
   * Register the open (background tab) session IDs for a provider.
   * Sessions that appear in both focused and open are reported as focused only.
   */
  registerOpen(key: string, ids: string[]): void {
    const prev = this.opened.get(key)
    if (prev && prev.length === ids.length && prev.every((v, i) => v === ids[i])) return
    this.opened.set(key, ids)
    this.flushViewed()
  }

  /** Debounced: send the aggregated focused + open session IDs to the server. */
  flushViewed(): void {
    if (!this.isRemoteEnabled()) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      const focus = new Set(this.focused.values())
      const open = new Set<string>()
      for (const ids of this.opened.values()) {
        for (const id of ids) {
          if (!focus.has(id)) open.add(id)
        }
      }
      this.client?.session
        .viewed({ focused: [...focus], open: [...open] })
        .catch((err) => console.warn("[TestAgent New] ConnectionService: viewed flush failed:", err))
    }, 150)
  }

  /**
   * Clean up everything: kill server, close SSE, clear listeners.
   */
  async restart(workspaceDir: string): Promise<void> {
    this.stopHealthPoll()
    this.sseClient?.dispose()
    this.serverManager.dispose()
    this.sseClient = null
    this.client = null
    this.config = null
    this.info = null
    this.connectPromise = null
    this.setState("connecting")
    await this.connect(workspaceDir)
  }

  dispose(): void {
    this.stopHealthPoll()
    this.sseClient?.dispose()
    this.serverManager.dispose()
    this.eventListeners.clear()
    this.stateListeners.clear()
    this.notificationDismissListeners.clear()
    this.profileChangeListeners.clear()
    this.migrationCompleteListeners.clear()
    this.favoritesChangeListeners.clear()
    this.clearPendingPromptsListeners.clear()
    this.directoryProviders.clear()
    this.messageSessionIdsByMessageId.clear()
    this.focused.clear()
    this.opened.clear()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.unsubRemote?.()
    this.unsubRemote = null
    this.client = null
    this.sseClient = null
    this.config = null
    this.info = null
    this.state = "disconnected"
  }

  private setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  /**
   * Start polling GET /global/health every 10 seconds.
   * Ported from packages/app/src/context/server.tsx (HEALTH_POLL_INTERVAL_MS).
   * Provides a second detection channel for server death independent of the SSE heartbeat.
   * If the health check fails while we believe we are connected, the SSE client is
   * disconnected so its reconnect loop kicks in immediately.
   */
  private startHealthPoll(baseUrl: string, password: string): void {
    this.stopHealthPoll()

    this.healthPollTimer = setInterval(async () => {
      if (this.state !== "connected") {
        return
      }
      const healthy = await this.checkHealth(baseUrl, password)
      if (!healthy && this.state === "connected") {
        console.warn("[TestAgent] ConnectionService: ❤️‍🩹 Health check failed — forcing SSE reconnect")
        this.sseClient?.reconnect()
      }
    }, HEALTH_POLL_INTERVAL_MS)

    // Don't keep the extension host alive just for the health poll
    this.healthPollTimer.unref?.()
  }

  private stopHealthPoll(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer)
      this.healthPollTimer = null
    }
  }

  private async checkHealth(baseUrl: string, password: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  private async doConnect(workspaceDir: string): Promise<void> {
    // If we reconnect, ensure the previous SSE connection is cleaned up first.
    this.stopHealthPoll()
    this.sseClient?.dispose()

    const server = await this.serverManager.getServer()
    this.info = { port: server.port }

    const config: ServerConfig = {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: server.password,
    }

    this.config = config

    // Create SDK client with Basic Auth header
    const authHeader = `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`
    this.client = createKiloClient({
      baseUrl: config.baseUrl,
      headers: {
        Authorization: authHeader,
      },
    })

    this.sseClient = new SdkSSEAdapter(this.client)

    // Wait until SSE actually reaches a terminal state before resolving connect().
    let resolveConnected: (() => void) | null = null
    let rejectConnected: ((error: Error) => void) | null = null
    const connectedPromise = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve
      rejectConnected = reject
    })

    let didConnect = false

    // Wire SSE events → broadcast to all registered listeners
    this.sseClient.onEvent((event) => {
      for (const listener of this.eventListeners) {
        listener(event)
      }
    })

    this.sseClient.onError((error) => {
      this.setState("error")
      rejectConnected?.(error)
      resolveConnected = null
      rejectConnected = null
    })

    // Wire SSE state → broadcast to all registered state listeners
    this.sseClient.onStateChange((sseState) => {
      this.setState(sseState)

      if (sseState === "connected") {
        didConnect = true
        resolveConnected?.()
        resolveConnected = null
        rejectConnected = null
        return
      }

      if (!didConnect && sseState === "disconnected") {
        rejectConnected?.(new Error(`SSE connection ended in state: ${sseState}`))
        resolveConnected = null
        rejectConnected = null
      }
    })

    this.sseClient.connect()

    await connectedPromise

    // Start the independent health poll once we are confirmed connected.
    this.startHealthPoll(config.baseUrl, config.password)

    // testagent_change start - push current user ID to CLI after connection
    await this.syncUserId()
    // testagent_change end
  }

  // testagent_change start - sync VS Code auth session user ID to CLI server
  private async syncUserId(): Promise<void> {
    if (!this.config) return
    try {
      const session = await vscode.authentication.getSession("tscode-oauth", [], { createIfNone: false })
      const id = session?.account.id
      const name = session?.account.label
      const token = session?.accessToken
      const auth = `Basic ${Buffer.from(`opencode:${this.config.password}`).toString("base64")}`
      await fetch(`${this.config.baseUrl}/kilocode/testagent/user`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ id, name, token }),
      })
    } catch {
      // non-critical, ignore
    }
  }
  // testagent_change end
}

async function drainSuggestions(client: KiloClient, directory: string): Promise<void> {
  const { data, error: err } = await client.suggestion.list({ directory })
  if (err) throw new Error(`Failed to list suggestions for ${directory}: ${String(err)}`)
  if (data) {
    for (const s of data) {
      const { error } = await client.suggestion.dismiss({ requestID: s.id, directory })
      if (error) throw new Error(`Failed to dismiss suggestion ${s.id}: ${String(error)}`)
    }
  }
}
===
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { NodeServerManager } from "./node-server-manager"
import { isTestagentBun } from "./runtime"
import { createKiloClient, type KiloClient, type Event } from "@kilocode/sdk/v2/client"
import { SdkSSEAdapter } from "./sdk-sse-adapter"
import type { ServerConfig } from "./types"
import { resolveEventSessionId as resolveEventSessionIdPure } from "./connection-utils"

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error"
type SSEEventListener = (event: Event) => void
type StateListener = (state: ConnectionState) => void
type SSEEventFilter = (event: Event) => boolean
type NotificationDismissListener = (notificationId: string) => void
type LanguageChangeListener = (locale: string) => void
type ProfileChangeListener = (data: unknown) => void
type MigrationCompleteListener = () => void
type FavoritesChangeListener = (favorites: Array<{ providerID: string; modelID: string }>) => void
type ClearPendingPromptsListener = () => void
type DirectoryProvider = () => string[]

// Poll /global/health at the same interval as packages/app/src/context/server.tsx.
// This provides a second detection channel for server death independent of the SSE heartbeat.
const HEALTH_POLL_INTERVAL_MS = 10_000

/**
 * Reject all pending network-offline waits for a given directory.
 * The network namespace is not yet in the SDK KiloClient type (pending SDK regeneration),
 * so we access it via a type assertion.
 */
async function drainNetworkWaits(client: KiloClient, dir: string) {
  const net = (client as any).network as
    | {
        list: (p: { directory: string }) => Promise<{ data?: { id: string }[]; error?: unknown }>
        reject: (p: { requestID: string; directory: string }) => Promise<{ error?: unknown }>
      }
    | undefined
  if (!net) return
  const { data: waits, error: err } = await net.list({ directory: dir })
  if (err) throw new Error(`Failed to list network waits for ${dir}: ${String(err)}`)
  if (!waits) return
  for (const w of waits) {
    const { error } = await net.reject({ requestID: w.id, directory: dir })
    if (error) throw new Error(`Failed to reject network wait ${w.id}: ${String(error)}`)
  }
}

/**
 * Shared connection service that owns the single ServerManager, KiloClient (SDK), and SdkSSEAdapter.
 * Multiple KiloProvider instances subscribe to it for SSE events and state changes.
 */
export class KiloConnectionService {
  private readonly serverManager: ServerManager | NodeServerManager
  private client: KiloClient | null = null
  private sseClient: SdkSSEAdapter | null = null
  private info: { port: number } | null = null
  private config: ServerConfig | null = null
  private state: ConnectionState = "disconnected"
  private connectPromise: Promise<void> | null = null
  private healthPollTimer: ReturnType<typeof setInterval> | null = null
  private remoteService: import("../RemoteStatusService").RemoteStatusService | null = null

  private readonly eventListeners: Set<SSEEventListener> = new Set()
  private readonly stateListeners: Set<StateListener> = new Set()
  private readonly notificationDismissListeners: Set<NotificationDismissListener> = new Set()
  private readonly languageChangeListeners: Set<LanguageChangeListener> = new Set()
  private readonly profileChangeListeners: Set<ProfileChangeListener> = new Set()
  private readonly migrationCompleteListeners: Set<MigrationCompleteListener> = new Set()
  private readonly favoritesChangeListeners: Set<FavoritesChangeListener> = new Set()
  private readonly clearPendingPromptsListeners: Set<ClearPendingPromptsListener> = new Set()
  private readonly directoryProviders: Set<DirectoryProvider> = new Set()

  /**
   * Shared mapping used to resolve session scope for events that don't reliably include a sessionID.
   * Used primarily for message.part.updated where only messageID may be present.
   */
  private readonly messageSessionIdsByMessageId: Map<string, string> = new Map()

  /** Provider key → single focused session ID. */
  private readonly focused: Map<string, string> = new Map()
  /** Provider key → all open (background) session IDs. */
  private readonly opened: Map<string, string[]> = new Map()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private unsubRemote: (() => void) | null = null

  constructor(context: vscode.ExtensionContext) {
    this.serverManager = isTestagentBun() ? new ServerManager(context) : new NodeServerManager(context)
    // testagent_change start - sync user ID to CLI whenever auth session changes
    if (isTestagentBun()) {
      context.subscriptions.push(
        vscode.authentication.onDidChangeSessions(async (e) => {
          if (e.provider.id === "tscode-oauth") {
            await this.syncUserId()
          }
        }),
      )
    }
    // testagent_change end
  }

  /**
   * Lazily start server + SSE. Multiple callers share the same promise.
   */
  async connect(workspaceDir: string): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise
    }
    if (this.state === "connected") {
      return
    }

    // Mark as connecting early so concurrent callers won't start another connection attempt.
    this.setState("connecting")

    this.connectPromise = this.doConnect(workspaceDir)
    try {
      await this.connectPromise
    } catch (error) {
      // If doConnect() fails before SSE can emit a state transition, avoid leaving consumers stuck in "connecting".
      this.setState("error")
      throw error
    } finally {
      this.connectPromise = null
    }
  }

  /**
   * Get the shared SDK client. Throws if not connected.
   */
  getClient(): KiloClient {
    if (!this.client) {
      throw new Error("Not connected — call connect() first")
    }
    return this.client
  }

  /**
   * Get the shared SDK client, auto-connecting if not yet started.
   * Accepts an optional directory to use as the workspace root; falls back
   * to the first VS Code workspace folder. Throws if neither is available
   * or if the connection fails.
   */
  async getClientAsync(dir?: string): Promise<KiloClient> {
    if (this.client) return this.client
    const root = dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) throw new Error("No workspace folder open")
    await this.connect(root)
    return this.client!
  }

  /**
   * Get server info (port). Returns null if not connected.
   */
  getServerInfo(): { port: number } | null {
    return this.info
  }

  /**
   * Get server config (baseUrl + password). Returns null if not connected.
   * Used by TelemetryProxy to POST events to the CLI server.
   */
  getServerConfig(): ServerConfig | null {
    return this.config
  }

  /**
   * Set the remote status service. When remote is disabled, flushViewed()
   * is a no-op. When remote becomes enabled (startup refresh, user toggle,
   * or SSE event), the accumulated focused/opened state is automatically
   * flushed so the server is never left unaware of already-open sessions.
   */
  setRemoteService(service: import("../RemoteStatusService").RemoteStatusService | null): void {
    this.unsubRemote?.()
    this.unsubRemote = null
    this.remoteService = service
    if (service) {
      this.unsubRemote = service.onChange((state) => {
        if (state.enabled) this.flushViewed()
      })
    }
  }

  private isRemoteEnabled(): boolean {
    return this.remoteService?.getState().enabled ?? false
  }

  /**
   * Current connection state.
   */
  getConnectionState(): ConnectionState {
    return this.state
  }

  /**
   * Subscribe to SSE events. Returns unsubscribe function.
   */
  onEvent(listener: SSEEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Subscribe to SSE events with a filter. The filter runs for every incoming SSE event.
   */
  onEventFiltered(filter: SSEEventFilter, listener: SSEEventListener): () => void {
    const wrapped: SSEEventListener = (event) => {
      if (!filter(event)) {
        return
      }
      listener(event)
    }
    return this.onEvent(wrapped)
  }

  /**
   * Record a messageID -> sessionID mapping, typically from message.updated or from HTTP message history.
   */
  recordMessageSessionId(messageId: string, sessionId: string): void {
    if (!messageId || !sessionId) {
      return
    }
    this.messageSessionIdsByMessageId.set(messageId, sessionId)
  }

  /**
   * Remove all messageID → sessionID entries for a given session.
   * Called when a session is deleted or otherwise pruned so the map
   * does not grow unbounded over the extension lifetime.
   */
  pruneSession(sessionId: string): void {
    for (const [mid, sid] of this.messageSessionIdsByMessageId) {
      if (sid === sessionId) this.messageSessionIdsByMessageId.delete(mid)
    }
  }

  /**
   * Best-effort sessionID extraction for an SSE event.
   * Returns undefined for global events.
   */
  resolveEventSessionId(event: Event): string | undefined {
    return resolveEventSessionIdPure(
      event,
      (messageId) => this.messageSessionIdsByMessageId.get(messageId),
      (messageId, sessionId) => this.recordMessageSessionId(messageId, sessionId),
    )
  }

  /**
   * Subscribe to notification dismiss events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onNotificationDismissed(listener: NotificationDismissListener): () => void {
    this.notificationDismissListeners.add(listener)
    return () => {
      this.notificationDismissListeners.delete(listener)
    }
  }

  /**
   * Broadcast a notification dismiss event to all subscribed KiloProvider instances.
   */
  notifyNotificationDismissed(notificationId: string): void {
    for (const listener of this.notificationDismissListeners) {
      listener(notificationId)
    }
  }

  /**
   * Subscribe to language change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onLanguageChanged(listener: LanguageChangeListener): () => void {
    this.languageChangeListeners.add(listener)
    return () => {
      this.languageChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a language change event to all subscribed KiloProvider instances.
   */
  notifyLanguageChanged(locale: string): void {
    for (const listener of this.languageChangeListeners) {
      listener(locale)
    }
  }

  /**
   * Subscribe to profile change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onProfileChanged(listener: ProfileChangeListener): () => void {
    this.profileChangeListeners.add(listener)
    return () => {
      this.profileChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a profile change event to all subscribed KiloProvider instances.
   */
  notifyProfileChanged(data: unknown): void {
    for (const listener of this.profileChangeListeners) {
      listener(data)
    }
  }

  /**
   * Subscribe to migration-complete events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onMigrationComplete(listener: MigrationCompleteListener): () => void {
    this.migrationCompleteListeners.add(listener)
    return () => {
      this.migrationCompleteListeners.delete(listener)
    }
  }

  /**
   * Broadcast a migration-complete event to all subscribed KiloProvider instances.
   */
  notifyMigrationComplete(): void {
    for (const listener of this.migrationCompleteListeners) {
      listener()
    }
  }

  /**
   * Subscribe to favorites change events broadcast from any KiloProvider. Returns unsubscribe function.
   */
  onFavoritesChanged(listener: FavoritesChangeListener): () => void {
    this.favoritesChangeListeners.add(listener)
    return () => {
      this.favoritesChangeListeners.delete(listener)
    }
  }

  /**
   * Broadcast a favorites change event to all subscribed KiloProvider instances.
   */
  notifyFavoritesChanged(favorites: Array<{ providerID: string; modelID: string }>): void {
    for (const listener of this.favoritesChangeListeners) {
      listener(favorites)
    }
  }

  /**
   * Subscribe to clear-pending-prompts broadcast. Returns unsubscribe function.
   * Fired after a config save drains all pending permissions/questions so each
   * webview can clear stale prompt UI.
   */
  onClearPendingPrompts(listener: ClearPendingPromptsListener): () => void {
    this.clearPendingPromptsListeners.add(listener)
    return () => {
      this.clearPendingPromptsListeners.delete(listener)
    }
  }

  /**
   * Register a callback that returns workspace directories tracked by a
   * KiloProvider (root + worktree dirs). Used by drainPendingPrompts() to
   * cover all active Instance directories across every provider.
   */
  registerDirectoryProvider(provider: DirectoryProvider): () => void {
    this.directoryProviders.add(provider)
    return () => {
      this.directoryProviders.delete(provider)
    }
  }

  /**
   * Reject all pending permission requests and questions across every
   * directory known to any KiloProvider **and** every project the CLI
   * backend has ever opened. The project list covers worktree sessions
   * whose provider was disposed (panel/sidebar closed) while the CLI
   * backend kept running.
   *
   * Must be called before operations that trigger Instance.disposeAll()
   * (e.g. config save) to prevent orphaned Promises from freezing
   * sessions.
   *
   * Throws if any list/reject call fails so callers can abort the
   * destructive operation.
   */
  async drainPendingPrompts(): Promise<void> {
    if (!this.client) return

    // Collect directories from all mounted providers (root + worktree dirs).
    const dirs = new Set<string>()
    for (const provider of this.directoryProviders) {
      for (const dir of provider()) {
        dirs.add(dir)
      }
    }

    // Also include every project directory the CLI backend knows about.
    // This covers worktree sessions whose KiloProvider was already disposed.
    const { data: projects, error: projectsErr } = await this.client.project.list()
    if (projectsErr) throw new Error(`Failed to list projects: ${String(projectsErr)}`)
    if (projects) {
      for (const p of projects) {
        dirs.add(p.worktree)
      }
    }

    for (const dir of dirs) {
      const { data: perms, error: permsErr } = await this.client.permission.list({ directory: dir })
      if (permsErr) throw new Error(`Failed to list permissions for ${dir}: ${String(permsErr)}`)
      if (perms) {
        for (const perm of perms) {
          const { error } = await this.client.permission.reply({ requestID: perm.id, reply: "reject", directory: dir })
          if (error) throw new Error(`Failed to reject permission ${perm.id}: ${String(error)}`)
        }
      }
      const { data: qs, error: qsErr } = await this.client.question.list({ directory: dir })
      if (qsErr) throw new Error(`Failed to list questions for ${dir}: ${String(qsErr)}`)
      if (qs) {
        for (const q of qs) {
          const { error } = await this.client.question.reject({ requestID: q.id, directory: dir })
          if (error) throw new Error(`Failed to reject question ${q.id}: ${String(error)}`)
        }
      }
      // testagent_change - these APIs only exist on the Kilo/testagent backend
      if (isTestagentBun()) {
        await drainSuggestions(this.client, dir)
        await drainNetworkWaits(this.client, dir)
      }
    }
    for (const listener of this.clearPendingPromptsListeners) {
      listener()
    }
  }

  /**
   * Subscribe to connection state changes. Returns unsubscribe function.
   */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /**
   * Register the session a provider is actively viewing (focused).
   * After any change the aggregated set is sent to the server (debounced).
   */
  registerFocused(key: string, sessionID: string): void {
    if (this.focused.get(key) === sessionID) return
    this.focused.set(key, sessionID)
    this.flushViewed()
  }

  /**
   * Unregister a provider's focused session (e.g. on dispose, hidden, or clearSession).
   */
  unregisterFocused(key: string): void {
    if (!this.focused.has(key)) return
    this.focused.delete(key)
    this.flushViewed()
  }

  /**
   * Register the open (background tab) session IDs for a provider.
   * Sessions that appear in both focused and open are reported as focused only.
   */
  registerOpen(key: string, ids: string[]): void {
    const prev = this.opened.get(key)
    if (prev && prev.length === ids.length && prev.every((v, i) => v === ids[i])) return
    this.opened.set(key, ids)
    this.flushViewed()
  }

  /** Debounced: send the aggregated focused + open session IDs to the server. */
  flushViewed(): void {
    if (!this.isRemoteEnabled()) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      const focus = new Set(this.focused.values())
      const open = new Set<string>()
      for (const ids of this.opened.values()) {
        for (const id of ids) {
          if (!focus.has(id)) open.add(id)
        }
      }
      this.client?.session
        .viewed({ focused: [...focus], open: [...open] })
        .catch((err) => console.warn("[TestAgent New] ConnectionService: viewed flush failed:", err))
    }, 150)
  }

  /**
   * Clean up everything: kill server, close SSE, clear listeners.
   */
  async restart(workspaceDir: string): Promise<void> {
    this.stopHealthPoll()
    this.sseClient?.dispose()
    this.serverManager.dispose()
    this.sseClient = null
    this.client = null
    this.config = null
    this.info = null
    this.connectPromise = null
    this.setState("connecting")
    await this.connect(workspaceDir)
  }

  dispose(): void {
    this.stopHealthPoll()
    this.sseClient?.dispose()
    this.serverManager.dispose()
    this.eventListeners.clear()
    this.stateListeners.clear()
    this.notificationDismissListeners.clear()
    this.profileChangeListeners.clear()
    this.migrationCompleteListeners.clear()
    this.favoritesChangeListeners.clear()
    this.clearPendingPromptsListeners.clear()
    this.directoryProviders.clear()
    this.messageSessionIdsByMessageId.clear()
    this.focused.clear()
    this.opened.clear()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.unsubRemote?.()
    this.unsubRemote = null
    this.client = null
    this.sseClient = null
    this.config = null
    this.info = null
    this.state = "disconnected"
  }

  private setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  /**
   * Start polling GET /global/health every 10 seconds.
   * Ported from packages/app/src/context/server.tsx (HEALTH_POLL_INTERVAL_MS).
   * Provides a second detection channel for server death independent of the SSE heartbeat.
   * If the health check fails while we believe we are connected, the SSE client is
   * disconnected so its reconnect loop kicks in immediately.
   */
  private startHealthPoll(baseUrl: string, password: string): void {
    this.stopHealthPoll()

    this.healthPollTimer = setInterval(async () => {
      if (this.state !== "connected") {
        return
      }
      const healthy = await this.checkHealth(baseUrl, password)
      if (!healthy && this.state === "connected") {
        console.warn("[TestAgent] ConnectionService: ❤️‍🩹 Health check failed — forcing SSE reconnect")
        this.sseClient?.reconnect()
      }
    }, HEALTH_POLL_INTERVAL_MS)

    // Don't keep the extension host alive just for the health poll
    this.healthPollTimer.unref?.()
  }

  private stopHealthPoll(): void {
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer)
      this.healthPollTimer = null
    }
  }

  private async checkHealth(baseUrl: string, password: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  private async doConnect(workspaceDir: string): Promise<void> {
    // If we reconnect, ensure the previous SSE connection is cleaned up first.
    this.stopHealthPoll()
    this.sseClient?.dispose()

    const server = await this.serverManager.getServer()
    this.info = { port: server.port }

    const config: ServerConfig = {
      baseUrl: `http://127.0.0.1:${server.port}`,
      password: server.password,
    }

    this.config = config

    // Create SDK client with Basic Auth header
    const authHeader = `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`
    this.client = createKiloClient({
      baseUrl: config.baseUrl,
      headers: {
        Authorization: authHeader,
      },
    })

    this.sseClient = new SdkSSEAdapter(this.client)

    // Wait until SSE actually reaches a terminal state before resolving connect().
    let resolveConnected: (() => void) | null = null
    let rejectConnected: ((error: Error) => void) | null = null
    const connectedPromise = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve
      rejectConnected = reject
    })

    let didConnect = false

    // Wire SSE events → broadcast to all registered listeners
    this.sseClient.onEvent((event) => {
      for (const listener of this.eventListeners) {
        listener(event)
      }
    })

    this.sseClient.onError((error) => {
      this.setState("error")
      rejectConnected?.(error)
      resolveConnected = null
      rejectConnected = null
    })

    // Wire SSE state → broadcast to all registered state listeners
    this.sseClient.onStateChange((sseState) => {
      this.setState(sseState)

      if (sseState === "connected") {
        didConnect = true
        resolveConnected?.()
        resolveConnected = null
        rejectConnected = null
        return
      }

      if (!didConnect && sseState === "disconnected") {
        rejectConnected?.(new Error(`SSE connection ended in state: ${sseState}`))
        resolveConnected = null
        rejectConnected = null
      }
    })

    this.sseClient.connect()

    await connectedPromise

    // Start the independent health poll once we are confirmed connected.
    this.startHealthPoll(config.baseUrl, config.password)

    // testagent_change start - push current user ID to CLI after connection
    if (isTestagentBun()) {
      await this.syncUserId()
    }
    // testagent_change end
  }

  // testagent_change start - sync VS Code auth session user ID to CLI server
  private async syncUserId(): Promise<void> {
    if (!this.config) return
    try {
      const session = await vscode.authentication.getSession("tscode-oauth", [], { createIfNone: false })
      const id = session?.account.id
      const name = session?.account.label
      const token = session?.accessToken
      const auth = `Basic ${Buffer.from(`opencode:${this.config.password}`).toString("base64")}`
      await fetch(`${this.config.baseUrl}/kilocode/testagent/user`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ id, name, token }),
      })
    } catch {
      // non-critical, ignore
    }
  }
  // testagent_change end
}

async function drainSuggestions(client: KiloClient, directory: string): Promise<void> {
  const { data, error: err } = await client.suggestion.list({ directory })
  if (err) throw new Error(`Failed to list suggestions for ${directory}: ${String(err)}`)
  if (data) {
    for (const s of data) {
      const { error } = await client.suggestion.dismiss({ requestID: s.id, directory })
      if (error) throw new Error(`Failed to dismiss suggestion ${s.id}: ${String(error)}`)
    }
  }
}
```

- 类型改为 `ServerManager | NodeServerManager`
- 构造时根据 `isTestagentBun()` 选择
- `syncUserId()` 仅 testagent-bun 调用
- `drainSuggestions()` / `drainNetworkWaits()` 仅 testagent-bun 调用

#### 3. [extension.ts](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/src/extension.ts)
```diff:extension.ts
import * as vscode from "vscode"
import * as path from "path"
import * as net from "net" // testagent_change - import net at top level
import { KiloProvider } from "./KiloProvider"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
// testagent_change - KiloClaw disabled
// import { KiloClawProvider } from "./kiloclaw/KiloClawProvider"
import { DiffViewerProvider } from "./DiffViewerProvider"
import { DiffVirtualProvider } from "./DiffVirtualProvider"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
import { SubAgentViewerProvider } from "./SubAgentViewerProvider"
import { EXTENSION_DISPLAY_NAME } from "./constants"
import { KiloConnectionService } from "./services/cli-backend"
import { registerAutocompleteProvider } from "./services/autocomplete"
import { ensureBackendForAutocomplete } from "./services/autocomplete/ensure-backend"
import { AutocompleteServiceManager } from "./services/autocomplete/AutocompleteServiceManager"
import { BrowserAutomationService } from "./services/browser-automation"
import { TelemetryProxy } from "./services/telemetry"
import { registerCommitMessageService } from "./services/commit-message"
import { registerCodeActions, registerTerminalActions, KiloCodeActionProvider } from "./services/code-actions"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { ensureCliInPath } from "./services/env-path"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"

// Activated via "onStartupFinished" (package.json) so that commands, code actions, keybindings,
// autocomplete, commit-message generation, and URI deep links all work immediately — without
// requiring the user to open a Kilo sidebar or panel first. The CLI backend is NOT spawned here;
// it starts lazily when a webview connects or when ensureBackendForAutocomplete() triggers it.
export function activate(context: vscode.ExtensionContext) {
  console.log("TestAgent extension is now active")

  // Add CLI to PATH on first activation (Windows only)
  // void ensureCliInPath(context)

  const telemetry = TelemetryProxy.getInstance()

  // Create shared connection service (one server for all webviews)
  const connectionService = new KiloConnectionService(context)

  // Create browser automation service (manages Playwright MCP registration)
  const browserAutomationService = new BrowserAutomationService(connectionService)
  browserAutomationService.syncWithSettings()

  // Create remote status service (one status bar item for all webviews)
  const remoteService = new RemoteStatusService()
  context.subscriptions.push(remoteService)
  connectionService.setRemoteService(remoteService)

  // Re-register browser automation MCP server on CLI backend reconnect, configure telemetry,
  // set remote service client, and reload autocomplete so it picks up the now-available backend connection.
  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      browserAutomationService.reregisterIfEnabled()
      const config = connectionService.getServerConfig()
      if (config) {
        telemetry.configure(config.baseUrl, config.password)
      }
      try {
        remoteService.setClient(connectionService.getClient())
        console.log("[TestAgent New] CLI connected, calling remoteService.refresh()")
        remoteService.refresh().catch((err) => console.warn("[TestAgent New] initial remote refresh failed:", err))
      } catch {
        remoteService.setClient(null)
      }
      AutocompleteServiceManager.getInstance()?.load()
    } else {
      remoteService.clearState()
      remoteService.setClient(null)
    }
  })

  // Prewarm the CLI backend early so autocomplete is ready before first editor use.
  ensureBackendForAutocomplete(connectionService)

  // Track all open tab panel providers so toolbar button commands can target them.
  // NOTE: The editor/title toolbar for tab panels intentionally omits Agent Manager
  // and Marketplace buttons (unlike the sidebar). Too many icons causes VS Code to
  // collapse them into a "..." overflow menu, hiding important buttons like Settings.
  const tabPanels = new Map<vscode.WebviewPanel, KiloProvider>()
  const activeTabProvider = () => {
    for (const [panel, p] of tabPanels) {
      if (panel.active) return p
    }
    return undefined
  }

  // Create the provider with shared service
  const provider = new KiloProvider(context.extensionUri, connectionService, context)
  provider.setRemoteService(remoteService)

  // Register the webview view provider for the sidebar.
  // retainContextWhenHidden keeps the webview alive when switching to other sidebar panels.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KiloProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Focus the view on startup so resolveWebviewView is triggered immediately,
  // preventing a blank panel that requires a manual click to initialize.
  vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`).then(undefined, () => {
    // Ignore errors if the view container isn't visible yet
  })
  
  // Ensure Agent Manager navigation keybindings work when a VS Code terminal has focus.
  // The terminal intercepts all keystrokes unless the command is listed in
  // terminal.integrated.commandsToSkipShell, which only contains built-in
  // commands by default.
  const skip = ["testagent.new.agentManagerOpen", "testagent.new.agentManager.showTerminal"]
  if (process.platform === "darwin") skip.push("testagent.new.agentManager.runScript")
  ensureCommandsSkipShell(skip)

  // testagent_change - KiloClaw disabled
  // Create KiloClaw chat provider for editor panel
  // const kiloClawProvider = new KiloClawProvider(context.extensionUri, connectionService)
  // context.subscriptions.push(kiloClawProvider)

  // Create Agent Manager provider for editor panel
  const agentManagerHost = new VscodeHost(context.extensionUri, connectionService, context)
  const agentManagerProvider = new AgentManagerProvider(agentManagerHost, connectionService)
  context.subscriptions.push(agentManagerProvider)

  // Wire "Continue in Worktree" from sidebar → Agent Manager
  provider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )

  // Register serializer so Agent Manager restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(AgentManagerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const ctx = agentManagerHost.wrapExistingPanel(panel, {
          onBeforeMessage: (msg) => agentManagerProvider.handleMessage(msg),
        })
        agentManagerProvider.deserializePanel(ctx)
        return Promise.resolve()
      },
    }),
  )

  // testagent_change - KiloClaw disabled
  // Register serializer so KiloClaw panel restores when VS Code restarts
  // context.subscriptions.push(
  //   vscode.window.registerWebviewPanelSerializer(KiloClawProvider.viewType, {
  //     deserializeWebviewPanel(panel: vscode.WebviewPanel) {
  //       kiloClawProvider.restorePanel(panel)
  //       return Promise.resolve()
  //     },
  //   }),
  // )

  // Register serializer so "Open in Tab" restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("testagent.new.TabPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const tabProvider = new KiloProvider(context.extensionUri, connectionService, context)
        tabProvider.setRemoteService(remoteService)
        tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
          agentManagerProvider.continueFromSidebar(sessionId, progress),
        )
        tabProvider.setDiffVirtualProvider(diffVirtualProvider)
        tabProvider.resolveWebviewPanel(panel)
        tabPanels.set(panel, tabProvider)
        panel.onDidDispose(
          () => {
            console.log("[TestAgent] Tab panel restored from restart disposed")
            tabPanels.delete(panel)
            tabProvider.dispose()
          },
          null,
          context.subscriptions,
        )
        return Promise.resolve()
      },
    }),
  )

  // Create standalone diff viewer provider for the sidebar "Show Changes" action
  const diffViewerProvider = new DiffViewerProvider(context.extensionUri, connectionService)
  diffViewerProvider.setCommentHandler((comments, autoSend) => {
    void provider.appendReviewComments(comments, autoSend)
  })
  context.subscriptions.push(diffViewerProvider)

  // Create diff virtual provider (lightweight single-file diff for permission approval)
  const diffVirtualProvider = new DiffVirtualProvider(context.extensionUri, connectionService) // testagent_change - add connectionService
  provider.setDiffVirtualProvider(diffVirtualProvider)
  agentManagerHost.setDiffVirtualProvider(diffVirtualProvider)
  context.subscriptions.push(diffVirtualProvider)

  // Create settings/profile editor provider (opens in editor area, not sidebar)
  const settingsEditorProvider = new SettingsEditorProvider(context.extensionUri, connectionService, context)
  settingsEditorProvider.setRemoteService(remoteService)
  context.subscriptions.push(settingsEditorProvider)

  // Create sub-agent viewer provider (read-only editor panel for sub-agent sessions)
  const subAgentViewerProvider = new SubAgentViewerProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(subAgentViewerProvider)

  // Register serializers so settings/diff/sub-agent panels restore on restart
  const settingsViews = ["settingsPanel", "profilePanel", "marketplacePanel"] as const
  for (const suffix of settingsViews) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(`testagent.new.${suffix}`, {
        deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          settingsEditorProvider.deserializePanel(panel)
          return Promise.resolve()
        },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DiffViewerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        diffViewerProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("testagent.new.SubAgentViewerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        // Sub-agent viewer requires a session ID that can't be recovered
        // after restart, so dispose the stale panel cleanly.
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  // Register toolbar button command handlers
  context.subscriptions.push(
    vscode.commands.registerCommand("testagent.new.plusButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "plusButtonClicked" })
      else provider.postMessage({ type: "action", action: "plusButtonClicked" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
    }),
    //testagent_change 注释
    // vscode.commands.registerCommand("testagent.new.marketplaceButtonClicked", (directory?: string) => {
    //   settingsEditorProvider.openPanel("marketplace", undefined, directory)
    // }),
    // testagent_change - KiloClaw disabled
    // vscode.commands.registerCommand("testagent.new.kiloClawOpen", () => {
    //   kiloClawProvider.openPanel()
    // }),
    vscode.commands.registerCommand("testagent.new.historyButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "historyButtonClicked" })
      else provider.postMessage({ type: "action", action: "historyButtonClicked" })
    }),
    vscode.commands.registerCommand("testagent.new.cycleAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cycleAgentMode" })
      else provider.postMessage({ type: "action", action: "cycleAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cycleAgentMode" })
    }),
    vscode.commands.registerCommand("testagent.new.cyclePreviousAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      else provider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
    }),
    // vscode.commands.registerCommand("testagent.new.profileButtonClicked", () => {
    //   settingsEditorProvider.openPanel("profile")
    // }), // testagent_change
    vscode.commands.registerCommand("testagent.new.settingsButtonClicked", (tab?: string) => {
      settingsEditorProvider.openPanel("settings", tab)
    }),
    // legacy-migration start
    vscode.commands.registerCommand("testagent.new.openMigrationWizard", () => {
      provider.postMessage({ type: "migrationState", needed: true })
    }),
    // legacy-migration end
    vscode.commands.registerCommand("testagent.new.generateTerminalCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Describe the terminal command you want to generate",
        placeHolder: "e.g., find all .ts files modified in the last 24 hours",
      })
      if (!input) return
      await vscode.commands.executeCommand("testagent.SidebarProvider.focus")
      await provider.waitForReady()
      provider.postMessage({ type: "triggerTask", text: `Generate a terminal command: ${input}` })
    }),
    // testagent_change 去掉openinTab
    // vscode.commands.registerCommand("testagent.new.openInTab", () => {
    //   return openKiloInNewTab(context, connectionService, agentManagerProvider, tabPanels)
    // }),
    vscode.commands.registerCommand("testagent.new.openTestagentTerminal", async () => {
      const port = 16384 // testagent_change - fixed port

      // testagent_change start - check if CLI is already running on this port
      console.log("[TestAgent] Checking if port", port, "is in use...")
      const isPortInUse = await checkPortInUse(port)
      console.log("[TestAgent] Port", port, "in use:", isPortInUse)
      
      if (isPortInUse) {
        // Port is in use, show error and don't create/show terminal
        console.log("[TestAgent] Showing error message: CLI already running")
        vscode.window.showErrorMessage("TestAgent CLI 已启动")
        return
      }
      
      // Check if terminal already exists
      const existingTerminal = vscode.window.terminals.find((t) => t.name === "testagent")
      console.log("[TestAgent] Existing terminal found:", !!existingTerminal)
      if (existingTerminal) {
        // Terminal exists, just show it (don't create a new one)
        console.log("[TestAgent] Showing existing terminal")
        existingTerminal.show()
        return
      }
      // testagent_change end

      console.log("[TestAgent] Creating new terminal...")

      // testagent_change start - inject user ID into terminal env (non-blocking)
      let userId: string | undefined
      let userName: string | undefined
      
      // Don't wait for auth - get it in background and create terminal immediately
      const authPromise = (async () => {
        try {
          const session = await vscode.authentication.getSession("tscode-oauth", [], { createIfNone: false })
          userId = session?.account.id
          userName = session?.account.label
        } catch {
          // non-critical, ignore
        }
      })()
      
      // Create terminal immediately without waiting for auth
      const terminal = vscode.window.createTerminal({
        name: "testagent",
        iconPath: {
          light: vscode.Uri.file(context.asAbsolutePath("assets/icons/testagent_chat.png")),
          dark: vscode.Uri.file(context.asAbsolutePath("assets/icons/testagent_chat.png")),
        },
        location: { viewColumn: vscode.ViewColumn.Beside },
        env: { TESTAGENT_CALLER: "vscode" }, // testagent_change - start with basic env
        // On Windows, use PowerShell so quoted paths with spaces work correctly
        ...(process.platform === "win32" && {
          shellPath: "powershell.exe",
          shellArgs: ["-NoLogo"],
        }),
      })

      terminal.show()
      
      // Wait for auth to complete, then send command with env vars if available
      await authPromise
      
      let command = `testagent --port ${port}`
      if (userId) {
        // On Windows PowerShell, use $env: syntax; on Unix shells, use export
        if (process.platform === "win32") {
          command = `$env:TESTAGENT_USER_ID="${userId}"; ${userName ? `$env:TESTAGENT_USER_NAME="${userName}"; ` : ""}${command}`
        } else {
          command = `TESTAGENT_USER_ID="${userId}" ${userName ? `TESTAGENT_USER_NAME="${userName}" ` : ""}${command}`
        }
      }
      
      terminal.sendText(command)
      console.log("[TestAgent] Terminal created and command sent")
      // testagent_change end
    }),
    vscode.commands.registerCommand("testagent.new.showChanges", () => {
      diffViewerProvider.openPanel()
    }),
    vscode.commands.registerCommand("testagent.new.openSubAgentViewer", (sessionID: string, title?: string) => {
      subAgentViewerProvider.openPanel(sessionID, title)
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.previousSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionPrevious" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.nextSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionNext" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.previousTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabPrevious" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.nextTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabNext" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.showTerminal", () => {
      agentManagerProvider.showTerminalForCurrentSession()
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.runScript", () => {
      agentManagerProvider.postMessage({ type: "action", action: "runScript" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.toggleDiff", () => {
      agentManagerProvider.postMessage({ type: "action", action: "toggleDiff" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.showShortcuts", () => {
      agentManagerProvider.postMessage({ type: "action", action: "showShortcuts" })
    }),

    vscode.commands.registerCommand("testagent.new.agentManager.newTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.closeTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeTab" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.newWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newWorktree" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.openWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "openWorktree" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.closeWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeWorktree" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.advancedWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "advancedWorktree" })
    }),
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`testagent.new.agentManager.jumpTo${i + 1}`, () => {
        agentManagerProvider.postMessage({ type: "action", action: `jumpTo${i + 1}` })
      }),
    ),
  )

  // Register URI handler for session imports (vscode://testagent.testagent-tscode/kilocode/s/{sessionId})
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const match = uri.path.match(/^\/kilocode\/s\/([a-zA-Z0-9_-]+)$/)
        if (!match) return
        const sessionId = match[1]
        if (!sessionId) return
        console.log("[TestAgent New] URI handler: opening cloud session:", sessionId)
        await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
        provider.openCloudSession(sessionId)
      },
    }),
  )

  // Register autocomplete provider
  registerAutocompleteProvider(context, connectionService)

  // Register commit message generation
  registerCommitMessageService(context, connectionService)

  // Register toggle auto-approve shortcut (Ctrl+Alt+A / Cmd+Alt+A)
  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        const dir =
          provider.getSessionDirectories().get(sessionId) ?? agentManagerProvider.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const dir of provider.getSessionDirectories().values()) dirs.add(dir)
      for (const dir of agentManagerProvider.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )

  registerHeapSnapshot(context, connectionService)

  // Register code actions (editor context menus, terminal context menus, keyboard shortcuts)
  registerCodeActions(context, provider, agentManagerProvider)
  registerTerminalActions(context, provider, agentManagerProvider)

  // Register CodeActionProvider (lightbulb quick fixes)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  // Dispose services when extension deactivates (kills the server)
  context.subscriptions.push({
    dispose: () => {
      unsubscribeStateChange()
      browserAutomationService.dispose()
      provider.dispose()
      connectionService.dispose()
    },
  })
}

export function deactivate() {
  TelemetryProxy.getInstance().shutdown()
}

async function openKiloInNewTab(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  agentManagerProvider: AgentManagerProvider,
  tabPanels: Map<vscode.WebviewPanel, KiloProvider>,
  diffVirtualProvider: DiffVirtualProvider,
  remoteService: RemoteStatusService,
) {
  const lastCol = Math.max(...vscode.window.visibleTextEditors.map((e) => e.viewColumn || 0), 0)
  const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

  if (!hasVisibleEditors) {
    await vscode.commands.executeCommand("workbench.action.newGroupRight")
  }

  const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

  const panel = vscode.window.createWebviewPanel("testagent.new.TabPanel", EXTENSION_DISPLAY_NAME, targetCol, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  })

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-light.png"),
    dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-dark.png"),
  }

  const tabProvider = new KiloProvider(context.extensionUri, connectionService, context)
  tabProvider.setRemoteService(remoteService)
  tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )
  tabProvider.setDiffVirtualProvider(diffVirtualProvider)
  tabProvider.resolveWebviewPanel(panel)
  tabPanels.set(panel, tabProvider)

  // Wait for the new panel to become active before locking the editor group.
  // This avoids the race where VS Code hasn't switched focus yet.
  await waitForWebviewPanelToBeActive(panel)
  await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

  panel.onDidDispose(
    () => {
      console.log("[TestAgent] Tab panel disposed")
      tabPanels.delete(panel)
      tabProvider.dispose()
    },
    null,
    context.subscriptions,
  )
}

/**
 * Add extension commands to terminal.integrated.commandsToSkipShell so they
 * work when a VS Code terminal has focus. The setting only ships with built-in
 * commands; extension commands must be added explicitly.
 */
function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  // Update whichever scope already carries an override so we don't
  // shadow workspace settings or leak workspace values into global.
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}

function waitForWebviewPanelToBeActive(panel: vscode.WebviewPanel): Promise<void> {
  if (panel.active) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const disposable = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.active) {
        return
      }
      disposable.dispose()
      resolve()
    })
  })
}

// testagent_change start - check if port is in use
async function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true)
      } else {
        resolve(false)
      }
    })
    
    server.once("listening", () => {
      server.close(() => {
        resolve(false)
      })
    })
    
    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      try {
        server.close()
      } catch {
        // ignore
      }
      resolve(false)
    }, 500)
    
    server.on("close", () => {
      clearTimeout(timeout)
    })
    
    try {
      server.listen(port, "127.0.0.1")
    } catch {
      clearTimeout(timeout)
      resolve(false)
    }
  })
}
// testagent_change end
===
import * as vscode from "vscode"
import * as path from "path"
import * as net from "net" // testagent_change - import net at top level
import { isTestagentBun } from "./services/cli-backend/runtime"
import { KiloProvider } from "./KiloProvider"
import { AgentManagerProvider } from "./agent-manager/AgentManagerProvider"
import { VscodeHost } from "./agent-manager/vscode-host"
// testagent_change - KiloClaw disabled
// import { KiloClawProvider } from "./kiloclaw/KiloClawProvider"
import { DiffViewerProvider } from "./DiffViewerProvider"
import { DiffVirtualProvider } from "./DiffVirtualProvider"
import { SettingsEditorProvider } from "./SettingsEditorProvider"
import { SubAgentViewerProvider } from "./SubAgentViewerProvider"
import { EXTENSION_DISPLAY_NAME } from "./constants"
import { KiloConnectionService } from "./services/cli-backend"
import { registerAutocompleteProvider } from "./services/autocomplete"
import { ensureBackendForAutocomplete } from "./services/autocomplete/ensure-backend"
import { AutocompleteServiceManager } from "./services/autocomplete/AutocompleteServiceManager"
import { BrowserAutomationService } from "./services/browser-automation"
import { TelemetryProxy } from "./services/telemetry"
import { registerCommitMessageService } from "./services/commit-message"
import { registerCodeActions, registerTerminalActions, KiloCodeActionProvider } from "./services/code-actions"
import { registerToggleAutoApprove } from "./commands/toggle-auto-approve"
import { ensureCliInPath } from "./services/env-path"
import { registerHeapSnapshot } from "./commands/heap-snapshot"
import { RemoteStatusService } from "./services/RemoteStatusService"

// Activated via "onStartupFinished" (package.json) so that commands, code actions, keybindings,
// autocomplete, commit-message generation, and URI deep links all work immediately — without
// requiring the user to open a Kilo sidebar or panel first. The CLI backend is NOT spawned here;
// it starts lazily when a webview connects or when ensureBackendForAutocomplete() triggers it.
export function activate(context: vscode.ExtensionContext) {
  console.log("TestAgent extension is now active")

  // Add CLI to PATH on first activation (Windows only)
  // void ensureCliInPath(context)

  const telemetry = isTestagentBun() ? TelemetryProxy.getInstance() : null

  // Create shared connection service (one server for all webviews)
  const connectionService = new KiloConnectionService(context)

  // Create browser automation service (manages Playwright MCP registration)
  const browserAutomationService = new BrowserAutomationService(connectionService)
  browserAutomationService.syncWithSettings()

  // Create remote status service (one status bar item for all webviews)
  // Only available with testagent backend (depends on kilo-specific remote.* API)
  const remoteService = isTestagentBun() ? new RemoteStatusService() : null
  if (remoteService) {
    context.subscriptions.push(remoteService)
    connectionService.setRemoteService(remoteService)
  }

  // Re-register browser automation MCP server on CLI backend reconnect, configure telemetry,
  // set remote service client, and reload autocomplete so it picks up the now-available backend connection.
  const unsubscribeStateChange = connectionService.onStateChange((state) => {
    if (state === "connected") {
      browserAutomationService.reregisterIfEnabled()
      if (telemetry) {
        const config = connectionService.getServerConfig()
        if (config) {
          telemetry.configure(config.baseUrl, config.password)
        }
      }
      if (remoteService) {
        try {
          remoteService.setClient(connectionService.getClient())
          console.log("[TestAgent New] CLI connected, calling remoteService.refresh()")
          remoteService.refresh().catch((err) => console.warn("[TestAgent New] initial remote refresh failed:", err))
        } catch {
          remoteService.setClient(null)
        }
      }
      AutocompleteServiceManager.getInstance()?.load()
    } else {
      if (remoteService) {
        remoteService.clearState()
        remoteService.setClient(null)
      }
    }
  })

  // Prewarm the CLI backend early so autocomplete is ready before first editor use.
  ensureBackendForAutocomplete(connectionService)

  // Track all open tab panel providers so toolbar button commands can target them.
  // NOTE: The editor/title toolbar for tab panels intentionally omits Agent Manager
  // and Marketplace buttons (unlike the sidebar). Too many icons causes VS Code to
  // collapse them into a "..." overflow menu, hiding important buttons like Settings.
  const tabPanels = new Map<vscode.WebviewPanel, KiloProvider>()
  const activeTabProvider = () => {
    for (const [panel, p] of tabPanels) {
      if (panel.active) return p
    }
    return undefined
  }

  // Create the provider with shared service
  const provider = new KiloProvider(context.extensionUri, connectionService, context)
  if (remoteService) provider.setRemoteService(remoteService)

  // Register the webview view provider for the sidebar.
  // retainContextWhenHidden keeps the webview alive when switching to other sidebar panels.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KiloProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // Focus the view on startup so resolveWebviewView is triggered immediately,
  // preventing a blank panel that requires a manual click to initialize.
  vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`).then(undefined, () => {
    // Ignore errors if the view container isn't visible yet
  })
  
  // Ensure Agent Manager navigation keybindings work when a VS Code terminal has focus.
  // The terminal intercepts all keystrokes unless the command is listed in
  // terminal.integrated.commandsToSkipShell, which only contains built-in
  // commands by default.
  const skip = ["testagent.new.agentManagerOpen", "testagent.new.agentManager.showTerminal"]
  if (process.platform === "darwin") skip.push("testagent.new.agentManager.runScript")
  ensureCommandsSkipShell(skip)

  // testagent_change - KiloClaw disabled
  // Create KiloClaw chat provider for editor panel
  // const kiloClawProvider = new KiloClawProvider(context.extensionUri, connectionService)
  // context.subscriptions.push(kiloClawProvider)

  // Create Agent Manager provider for editor panel
  const agentManagerHost = new VscodeHost(context.extensionUri, connectionService, context)
  const agentManagerProvider = new AgentManagerProvider(agentManagerHost, connectionService)
  context.subscriptions.push(agentManagerProvider)

  // Wire "Continue in Worktree" from sidebar → Agent Manager
  provider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )

  // Register serializer so Agent Manager restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(AgentManagerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const ctx = agentManagerHost.wrapExistingPanel(panel, {
          onBeforeMessage: (msg) => agentManagerProvider.handleMessage(msg),
        })
        agentManagerProvider.deserializePanel(ctx)
        return Promise.resolve()
      },
    }),
  )

  // testagent_change - KiloClaw disabled
  // Register serializer so KiloClaw panel restores when VS Code restarts
  // context.subscriptions.push(
  //   vscode.window.registerWebviewPanelSerializer(KiloClawProvider.viewType, {
  //     deserializeWebviewPanel(panel: vscode.WebviewPanel) {
  //       kiloClawProvider.restorePanel(panel)
  //       return Promise.resolve()
  //     },
  //   }),
  // )

  // Register serializer so "Open in Tab" restores when VS Code restarts
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("testagent.new.TabPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        const tabProvider = new KiloProvider(context.extensionUri, connectionService, context)
        if (remoteService) tabProvider.setRemoteService(remoteService)
        tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
          agentManagerProvider.continueFromSidebar(sessionId, progress),
        )
        tabProvider.setDiffVirtualProvider(diffVirtualProvider)
        tabProvider.resolveWebviewPanel(panel)
        tabPanels.set(panel, tabProvider)
        panel.onDidDispose(
          () => {
            console.log("[TestAgent] Tab panel restored from restart disposed")
            tabPanels.delete(panel)
            tabProvider.dispose()
          },
          null,
          context.subscriptions,
        )
        return Promise.resolve()
      },
    }),
  )

  // Create standalone diff viewer provider for the sidebar "Show Changes" action
  const diffViewerProvider = new DiffViewerProvider(context.extensionUri, connectionService)
  diffViewerProvider.setCommentHandler((comments, autoSend) => {
    void provider.appendReviewComments(comments, autoSend)
  })
  context.subscriptions.push(diffViewerProvider)

  // Create diff virtual provider (lightweight single-file diff for permission approval)
  const diffVirtualProvider = new DiffVirtualProvider(context.extensionUri, connectionService) // testagent_change - add connectionService
  provider.setDiffVirtualProvider(diffVirtualProvider)
  agentManagerHost.setDiffVirtualProvider(diffVirtualProvider)
  context.subscriptions.push(diffVirtualProvider)

  // Create settings/profile editor provider (opens in editor area, not sidebar)
  const settingsEditorProvider = new SettingsEditorProvider(context.extensionUri, connectionService, context)
  if (remoteService) settingsEditorProvider.setRemoteService(remoteService)
  context.subscriptions.push(settingsEditorProvider)

  // Create sub-agent viewer provider (read-only editor panel for sub-agent sessions)
  const subAgentViewerProvider = new SubAgentViewerProvider(context.extensionUri, connectionService, context)
  context.subscriptions.push(subAgentViewerProvider)

  // Register serializers so settings/diff/sub-agent panels restore on restart
  const settingsViews = ["settingsPanel", "profilePanel", "marketplacePanel"] as const
  for (const suffix of settingsViews) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(`testagent.new.${suffix}`, {
        deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          settingsEditorProvider.deserializePanel(panel)
          return Promise.resolve()
        },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DiffViewerProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        diffViewerProvider.deserializePanel(panel)
        return Promise.resolve()
      },
    }),
  )

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("testagent.new.SubAgentViewerPanel", {
      deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        // Sub-agent viewer requires a session ID that can't be recovered
        // after restart, so dispose the stale panel cleanly.
        panel.dispose()
        return Promise.resolve()
      },
    }),
  )

  // Register toolbar button command handlers
  context.subscriptions.push(
    vscode.commands.registerCommand("testagent.new.plusButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "plusButtonClicked" })
      else provider.postMessage({ type: "action", action: "plusButtonClicked" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManagerOpen", () => {
      agentManagerProvider.openPanel()
    }),
    //testagent_change 注释
    // vscode.commands.registerCommand("testagent.new.marketplaceButtonClicked", (directory?: string) => {
    //   settingsEditorProvider.openPanel("marketplace", undefined, directory)
    // }),
    // testagent_change - KiloClaw disabled
    // vscode.commands.registerCommand("testagent.new.kiloClawOpen", () => {
    //   kiloClawProvider.openPanel()
    // }),
    vscode.commands.registerCommand("testagent.new.historyButtonClicked", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "historyButtonClicked" })
      else provider.postMessage({ type: "action", action: "historyButtonClicked" })
    }),
    vscode.commands.registerCommand("testagent.new.cycleAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cycleAgentMode" })
      else provider.postMessage({ type: "action", action: "cycleAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cycleAgentMode" })
    }),
    vscode.commands.registerCommand("testagent.new.cyclePreviousAgentMode", () => {
      const tab = activeTabProvider()
      if (tab) tab.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      else provider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
      agentManagerProvider.postMessage({ type: "action", action: "cyclePreviousAgentMode" })
    }),
    // vscode.commands.registerCommand("testagent.new.profileButtonClicked", () => {
    //   settingsEditorProvider.openPanel("profile")
    // }), // testagent_change
    vscode.commands.registerCommand("testagent.new.settingsButtonClicked", (tab?: string) => {
      settingsEditorProvider.openPanel("settings", tab)
    }),
    // legacy-migration start
    vscode.commands.registerCommand("testagent.new.openMigrationWizard", () => {
      provider.postMessage({ type: "migrationState", needed: true })
    }),
    // legacy-migration end
    vscode.commands.registerCommand("testagent.new.generateTerminalCommand", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Describe the terminal command you want to generate",
        placeHolder: "e.g., find all .ts files modified in the last 24 hours",
      })
      if (!input) return
      await vscode.commands.executeCommand("testagent.SidebarProvider.focus")
      await provider.waitForReady()
      provider.postMessage({ type: "triggerTask", text: `Generate a terminal command: ${input}` })
    }),
    // testagent_change 去掉openinTab
    // vscode.commands.registerCommand("testagent.new.openInTab", () => {
    //   return openKiloInNewTab(context, connectionService, agentManagerProvider, tabPanels)
    // }),
    vscode.commands.registerCommand("testagent.new.openTestagentTerminal", async () => {
      const port = 16384 // testagent_change - fixed port

      // testagent_change start - check if CLI is already running on this port
      console.log("[TestAgent] Checking if port", port, "is in use...")
      const isPortInUse = await checkPortInUse(port)
      console.log("[TestAgent] Port", port, "in use:", isPortInUse)
      
      if (isPortInUse) {
        // Port is in use, show error and don't create/show terminal
        console.log("[TestAgent] Showing error message: CLI already running")
        vscode.window.showErrorMessage("TestAgent CLI 已启动")
        return
      }
      
      // Check if terminal already exists
      const existingTerminal = vscode.window.terminals.find((t) => t.name === "testagent")
      console.log("[TestAgent] Existing terminal found:", !!existingTerminal)
      if (existingTerminal) {
        // Terminal exists, just show it (don't create a new one)
        console.log("[TestAgent] Showing existing terminal")
        existingTerminal.show()
        return
      }
      // testagent_change end

      console.log("[TestAgent] Creating new terminal...")

      // testagent_change start - inject user ID into terminal env (non-blocking)
      let userId: string | undefined
      let userName: string | undefined
      
      // Don't wait for auth - get it in background and create terminal immediately
      const authPromise = (async () => {
        try {
          const session = await vscode.authentication.getSession("tscode-oauth", [], { createIfNone: false })
          userId = session?.account.id
          userName = session?.account.label
        } catch {
          // non-critical, ignore
        }
      })()
      
      // Create terminal immediately without waiting for auth
      const terminal = vscode.window.createTerminal({
        name: "testagent",
        iconPath: {
          light: vscode.Uri.file(context.asAbsolutePath("assets/icons/testagent_chat.png")),
          dark: vscode.Uri.file(context.asAbsolutePath("assets/icons/testagent_chat.png")),
        },
        location: { viewColumn: vscode.ViewColumn.Beside },
        env: { TESTAGENT_CALLER: "vscode" }, // testagent_change - start with basic env
        // On Windows, use PowerShell so quoted paths with spaces work correctly
        ...(process.platform === "win32" && {
          shellPath: "powershell.exe",
          shellArgs: ["-NoLogo"],
        }),
      })

      terminal.show()
      
      // Wait for auth to complete, then send command with env vars if available
      await authPromise
      
      let command = `testagent --port ${port}`
      if (userId) {
        // On Windows PowerShell, use $env: syntax; on Unix shells, use export
        if (process.platform === "win32") {
          command = `$env:TESTAGENT_USER_ID="${userId}"; ${userName ? `$env:TESTAGENT_USER_NAME="${userName}"; ` : ""}${command}`
        } else {
          command = `TESTAGENT_USER_ID="${userId}" ${userName ? `TESTAGENT_USER_NAME="${userName}" ` : ""}${command}`
        }
      }
      
      terminal.sendText(command)
      console.log("[TestAgent] Terminal created and command sent")
      // testagent_change end
    }),
    vscode.commands.registerCommand("testagent.new.showChanges", () => {
      diffViewerProvider.openPanel()
    }),
    vscode.commands.registerCommand("testagent.new.openSubAgentViewer", (sessionID: string, title?: string) => {
      subAgentViewerProvider.openPanel(sessionID, title)
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.previousSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionPrevious" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.nextSession", () => {
      agentManagerProvider.postMessage({ type: "action", action: "sessionNext" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.previousTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabPrevious" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.nextTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "tabNext" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.showTerminal", () => {
      agentManagerProvider.showTerminalForCurrentSession()
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.runScript", () => {
      agentManagerProvider.postMessage({ type: "action", action: "runScript" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.toggleDiff", () => {
      agentManagerProvider.postMessage({ type: "action", action: "toggleDiff" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.showShortcuts", () => {
      agentManagerProvider.postMessage({ type: "action", action: "showShortcuts" })
    }),

    vscode.commands.registerCommand("testagent.new.agentManager.newTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newTab" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.closeTab", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeTab" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.newWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "newWorktree" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.openWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "openWorktree" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.closeWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "closeWorktree" })
    }),
    vscode.commands.registerCommand("testagent.new.agentManager.advancedWorktree", () => {
      agentManagerProvider.postMessage({ type: "action", action: "advancedWorktree" })
    }),
    ...Array.from({ length: 9 }, (_, i) =>
      vscode.commands.registerCommand(`testagent.new.agentManager.jumpTo${i + 1}`, () => {
        agentManagerProvider.postMessage({ type: "action", action: `jumpTo${i + 1}` })
      }),
    ),
  )

  // Register URI handler for session imports (vscode://testagent.testagent-tscode/kilocode/s/{sessionId})
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const match = uri.path.match(/^\/kilocode\/s\/([a-zA-Z0-9_-]+)$/)
        if (!match) return
        const sessionId = match[1]
        if (!sessionId) return
        console.log("[TestAgent New] URI handler: opening cloud session:", sessionId)
        await vscode.commands.executeCommand(`${KiloProvider.viewType}.focus`)
        provider.openCloudSession(sessionId)
      },
    }),
  )

  // Register autocomplete provider
  registerAutocompleteProvider(context, connectionService)

  // Register commit message generation
  registerCommitMessageService(context, connectionService)

  // Register toggle auto-approve shortcut (Ctrl+Alt+A / Cmd+Alt+A)
  const defaultDir = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  registerToggleAutoApprove(
    context,
    connectionService,
    (sessionId) => {
      if (sessionId) {
        const dir =
          provider.getSessionDirectories().get(sessionId) ?? agentManagerProvider.getSessionDirectories().get(sessionId)
        if (dir) return dir
      }
      return defaultDir()
    },
    () => {
      const dirs = new Set([defaultDir()])
      for (const dir of provider.getSessionDirectories().values()) dirs.add(dir)
      for (const dir of agentManagerProvider.getSessionDirectories().values()) dirs.add(dir)
      return [...dirs]
    },
  )

  registerHeapSnapshot(context, connectionService)

  // Register code actions (editor context menus, terminal context menus, keyboard shortcuts)
  registerCodeActions(context, provider, agentManagerProvider)
  registerTerminalActions(context, provider, agentManagerProvider)

  // Register CodeActionProvider (lightbulb quick fixes)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new KiloCodeActionProvider(),
      KiloCodeActionProvider.metadata,
    ),
  )

  // Dispose services when extension deactivates (kills the server)
  context.subscriptions.push({
    dispose: () => {
      unsubscribeStateChange()
      browserAutomationService.dispose()
      provider.dispose()
      connectionService.dispose()
    },
  })
}

export function deactivate() {
  TelemetryProxy.getInstance().shutdown()
}

async function openKiloInNewTab(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  agentManagerProvider: AgentManagerProvider,
  tabPanels: Map<vscode.WebviewPanel, KiloProvider>,
  diffVirtualProvider: DiffVirtualProvider,
  remoteService: RemoteStatusService,
) {
  const lastCol = Math.max(...vscode.window.visibleTextEditors.map((e) => e.viewColumn || 0), 0)
  const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

  if (!hasVisibleEditors) {
    await vscode.commands.executeCommand("workbench.action.newGroupRight")
  }

  const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

  const panel = vscode.window.createWebviewPanel("testagent.new.TabPanel", EXTENSION_DISPLAY_NAME, targetCol, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  })

  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-light.png"),
    dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo-dark.png"),
  }

  const tabProvider = new KiloProvider(context.extensionUri, connectionService, context)
  if (remoteService) tabProvider.setRemoteService(remoteService)
  tabProvider.setContinueInWorktreeHandler((sessionId, progress) =>
    agentManagerProvider.continueFromSidebar(sessionId, progress),
  )
  tabProvider.setDiffVirtualProvider(diffVirtualProvider)
  tabProvider.resolveWebviewPanel(panel)
  tabPanels.set(panel, tabProvider)

  // Wait for the new panel to become active before locking the editor group.
  // This avoids the race where VS Code hasn't switched focus yet.
  await waitForWebviewPanelToBeActive(panel)
  await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

  panel.onDidDispose(
    () => {
      console.log("[TestAgent] Tab panel disposed")
      tabPanels.delete(panel)
      tabProvider.dispose()
    },
    null,
    context.subscriptions,
  )
}

/**
 * Add extension commands to terminal.integrated.commandsToSkipShell so they
 * work when a VS Code terminal has focus. The setting only ships with built-in
 * commands; extension commands must be added explicitly.
 */
function ensureCommandsSkipShell(commands: string[]): void {
  const config = vscode.workspace.getConfiguration("terminal.integrated")
  const info = config.inspect<string[]>("commandsToSkipShell")
  // Update whichever scope already carries an override so we don't
  // shadow workspace settings or leak workspace values into global.
  const [existing, target] = info?.workspaceFolderValue
    ? [info.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
    : info?.workspaceValue
      ? [info.workspaceValue, vscode.ConfigurationTarget.Workspace]
      : [info?.globalValue ?? [], vscode.ConfigurationTarget.Global]
  const missing = commands.filter((cmd) => !existing.includes(cmd))
  if (missing.length === 0) return
  config.update("commandsToSkipShell", [...existing, ...missing], target)
}

function waitForWebviewPanelToBeActive(panel: vscode.WebviewPanel): Promise<void> {
  if (panel.active) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const disposable = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.active) {
        return
      }
      disposable.dispose()
      resolve()
    })
  })
}

// testagent_change start - check if port is in use
async function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true)
      } else {
        resolve(false)
      }
    })
    
    server.once("listening", () => {
      server.close(() => {
        resolve(false)
      })
    })
    
    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      try {
        server.close()
      } catch {
        // ignore
      }
      resolve(false)
    }, 500)
    
    server.on("close", () => {
      clearTimeout(timeout)
    })
    
    try {
      server.listen(port, "127.0.0.1")
    } catch {
      clearTimeout(timeout)
      resolve(false)
    }
  })
}
// testagent_change end
```

- `TelemetryProxy` 仅 testagent 初始化
- `RemoteStatusService` 仅 testagent 创建
- 所有 `setRemoteService()` 调用加了 null check

#### 4. [.vscodeignore](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/.vscodeignore)
```diff:.vscodeignore
.vscode/**
.vscode-test/**
out/**
node_modules/**
src/**
webview-ui/**
script/**
.gitignore
.yarnrc
.npmrc
esbuild.js
vsc-extension-quickstart.md
**/tsconfig.json
**/eslint.config.mjs
**/*.map
**/*.ts
**/.vscode-test.*
AGENTS.md
.prettierignore
.env
.env.*

# Include dist/ directory for compiled extension (production)
!dist/**

# Include bin/ directory for CLI binary (production)
!bin/**
===
.vscode/**
.vscode-test/**
out/**
node_modules/**
src/**
webview-ui/**
script/**
.gitignore
.yarnrc
.npmrc
esbuild.js
vsc-extension-quickstart.md
**/tsconfig.json
**/eslint.config.mjs
**/*.map
**/*.ts
**/.vscode-test.*
AGENTS.md
.prettierignore
.env
.env.*

# Include dist/ directory for compiled extension (production)
!dist/**

# Include bin/ directory for CLI binary (testagent/Bun build)
!bin/**

# Include opencode-server/ directory for Node.js server (opencode build)
!opencode-server/**
```

- 新增 `!opencode-server/**` 包含规则

#### 5. [package.json](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/package.json)
```diff:package.json
{
  "name": "testagent-tscode",
  "displayName": "TestAgent for TScode",
  "description": "TestAgent Code Extension",
  "version": "1.0.4",
  "icon": "assets/icons/logo-outline-black.png",
  "galleryBanner": {
    "color": "#FFFFFF",
    "theme": "light"
  },
  "publisher": "testagent",
  "repository": {
    "type": "git",
    "url": "https://github.com/Kilo-Org/kilocode.git",
    "directory": "packages/kilo-vscode"
  },
  "engines": {
    "vscode": "^1.105.1"
  },
  "license": "MIT",
  "author": {
    "name": "TestAgent"
  },
  "categories": [
    "AI",
    "Chat",
    "Programming Languages",
    "Education",
    "Snippets",
    "Testing"
  ],
  "keywords": [
    "kilo",
    "claude",
    "dev",
    "mcp",
    "openrouter",
    "coding",
    "agent",
    "autonomous",
    "chatgpt",
    "sonnet",
    "ai",
    "llama",
    "TestAgent",
    "kilocode"
  ],
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "taskDefinitions": [
      {
        "type": "kilo-worktree-setup",
        "properties": {
          "script": {
            "type": "string",
            "description": "The setup script command to execute"
          }
        }
      }
    ],
    "viewsContainers": {
      "secondarySidebar": [
        {
          "id": "testagent-ActivityBar",
          "title": "TestAgent",
          "icon": "assets/icons/ghost-svgrepo-com.svg"
        }
      ]
    },
    "views": {
      "testagent-ActivityBar": [
        {
          "type": "webview",
          "id": "testagent.SidebarProvider",
          "name": "TestAgent"
        }
      ]
    },
    "commands": [
      {
        "command": "testagent.new.plusButtonClicked",
        "title": "新建任务",
        "icon": "$(add)"
      },
      {
        "command": "testagent.new.historyButtonClicked",
        "title": "历史会话",
        "icon": "$(history)"
      },
      {
        "command": "testagent.new.settingsButtonClicked",
        "title": "设置",
        "icon": "$(settings-gear)"
      },
      {
        "command": "testagent.new.openInTab",
        "title": "TestAgent",
        "icon": {
          "light": "assets/icons/kilo-light.png",
          "dark": "assets/icons/kilo-dark.png"
        }
      },
      {
        "command": "testagent.new.showChanges",
        "title": "Show Changes",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.openMigrationWizard",
        "title": "Migrate Settings from Legacy Version",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.autocomplete.generateSuggestions",
        "title": "Generate Suggested Edits",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.autocomplete.cancelSuggestions",
        "title": "Cancel Suggested Edits",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.previousSession",
        "title": "Agent Manager: Previous Session",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.nextSession",
        "title": "Agent Manager: Next Session",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.previousTab",
        "title": "Agent Manager: Previous Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.nextTab",
        "title": "Agent Manager: Next Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.showTerminal",
        "title": "Agent Manager: Focus Terminal",
        "category": "TestAgent",
        "icon": "$(terminal)"
      },
      {
        "command": "testagent.new.agentManager.runScript",
        "title": "Agent Manager: Run Script",
        "category": "Kilo Code",
        "icon": "$(play)"
      },
      {
        "command": "testagent.new.agentManager.toggleDiff",
        "title": "Agent Manager: Toggle Diff Panel",
        "category": "TestAgent",
        "icon": "$(diff)"
      },
      {
        "command": "testagent.new.agentManager.showShortcuts",
        "title": "Agent Manager: Show Keyboard Shortcuts",
        "category": "TestAgent",
        "icon": "$(keyboard)"
      },
      {
        "command": "testagent.new.agentManager.newTab",
        "title": "Agent Manager: New Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.closeTab",
        "title": "Agent Manager: Close Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.newWorktree",
        "title": "Agent Manager: New Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.openWorktree",
        "title": "Agent Manager: Open Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.closeWorktree",
        "title": "Agent Manager: Close Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.advancedWorktree",
        "title": "Agent Manager: Advanced New Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo1",
        "title": "Agent Manager: Jump to Item 1",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo2",
        "title": "Agent Manager: Jump to Item 2",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo3",
        "title": "Agent Manager: Jump to Item 3",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo4",
        "title": "Agent Manager: Jump to Item 4",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo5",
        "title": "Agent Manager: Jump to Item 5",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo6",
        "title": "Agent Manager: Jump to Item 6",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo7",
        "title": "Agent Manager: Jump to Item 7",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo8",
        "title": "Agent Manager: Jump to Item 8",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo9",
        "title": "Agent Manager: Jump to Item 9",
        "category": "TestAgent"
      },

      {
        "command": "testagent.new.explainCode",
        "title": "Explain Code",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.fixCode",
        "title": "Fix Code",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.improveCode",
        "title": "Improve Code",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.addToContext",
        "title": "Add to Context",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.terminalAddToContext",
        "title": "Add Terminal Content to Context",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.terminalFixCommand",
        "title": "Fix This Command",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.terminalExplainCommand",
        "title": "Explain This Command",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.focusChatInput",
        "title": "Focus Chat Input",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.cycleAgentMode",
        "title": "Cycle Agent Mode",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.cyclePreviousAgentMode",
        "title": "Cycle Previous Agent Mode",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.toggleAutoApprove",
        "title": "Toggle Auto-Approve",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.generateTerminalCommand",
        "title": "Generate Terminal Command",
        "category": "TestAgent"
      }
    ],
    "submenus": [
      {
        "id": "testagent.new.editorContextMenu",
        "label": "TestAgent"
      },
      {
        "id": "testagent.new.terminalContextMenu",
        "label": "TestAgent"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "testagent.new.plusButtonClicked",
          "group": "navigation@0",
          "when": "view == testagent.SidebarProvider"
        },
        {
          "command": "testagent.new.historyButtonClicked",
          "group": "navigation@1",
          "when": "view == testagent.SidebarProvider"
        },
        {
          "command": "testagent.new.settingsButtonClicked",
          "group": "navigation@5",
          "when": "view == testagent.SidebarProvider"
        }
      ],
      "editor/title": [
        {
          "command": "testagent.new.plusButtonClicked",
          "group": "navigation@0",
          "when": "activeWebviewPanelId == testagent.new.TabPanel"
        },
        {
          "command": "testagent.new.historyButtonClicked",
          "group": "navigation@1",
          "when": "activeWebviewPanelId == testagent.new.TabPanel"
        },
        {
          "command": "testagent.new.settingsButtonClicked",
          "group": "navigation@3",
          "when": "activeWebviewPanelId == testagent.new.TabPanel"
        }
      ],
      "editor/context": [
        {
          "submenu": "testagent.new.editorContextMenu",
          "group": "1_testagent"
        }
      ],
      "testagent.new.editorContextMenu": [
        {
          "command": "testagent.new.explainCode",
          "group": "1_actions@1"
        },
        {
          "command": "testagent.new.fixCode",
          "group": "1_actions@2"
        },
        {
          "command": "testagent.new.improveCode",
          "group": "1_actions@3"
        },
        {
          "command": "testagent.new.addToContext",
          "group": "1_actions@4"
        }
      ],
      "terminal/context": [
        {
          "submenu": "testagent.new.terminalContextMenu",
          "group": "2_testagent"
        }
      ],
      "testagent.new.terminalContextMenu": [
        {
          "command": "testagent.new.terminalAddToContext",
          "group": "1_actions@1"
        },
        {
          "command": "testagent.new.terminalFixCommand",
          "group": "1_actions@2"
        },
        {
          "command": "testagent.new.terminalExplainCommand",
          "group": "1_actions@3"
        }
      ]
    },
    "keybindings": [
      {
        "command": "testagent.new.focusChatInput",
        "key": "ctrl+shift+a",
        "mac": "cmd+shift+a"
      },
      {
        "command": "testagent.new.toggleAutoApprove",
        "key": "ctrl+alt+a",
        "mac": "cmd+alt+a"
      },
      {
        "command": "testagent.new.generateTerminalCommand",
        "key": "ctrl+shift+g",
        "mac": "cmd+shift+g"
      },
      
      {
        "command": "testagent.new.addToContext",
        "key": "ctrl+k ctrl+a",
        "mac": "cmd+k cmd+a",
        "when": "editorTextFocus && editorHasSelection"
      },
      {
        "command": "testagent.new.cycleAgentMode",
        "key": "ctrl+.",
        "mac": "cmd+.",
        "when": "sideBarFocus && testagent.new.sidebarVisible || activeWebviewPanelId == 'testagent.new.AgentManagerPanel' || activeWebviewPanelId == 'testagent.new.TabPanel'"
      },
      {
        "command": "testagent.new.cyclePreviousAgentMode",
        "key": "ctrl+shift+.",
        "mac": "cmd+shift+.",
        "when": "sideBarFocus && testagent.new.sidebarVisible || activeWebviewPanelId == 'testagent.new.AgentManagerPanel' || activeWebviewPanelId == 'testagent.new.TabPanel'"
      },
      {
        "command": "testagent.new.autocomplete.cancelSuggestions",
        "key": "escape",
        "when": "editorTextFocus && !editorTabMovesFocus && !inSnippetMode && testagent.new.autocomplete.hasSuggestions"
      },
      {
        "command": "testagent.new.autocomplete.generateSuggestions",
        "key": "ctrl+l",
        "mac": "cmd+l",
        "when": "editorTextFocus && !editorTabMovesFocus && !inSnippetMode && testagent.autocomplete.enableSmartInlineTaskKeybinding && !github.copilot.completions.enabled"
      },
      {
        "command": "testagent.new.autocomplete.showIncompatibilityExtensionPopup",
        "key": "ctrl+l",
        "mac": "cmd+l",
        "when": "editorTextFocus && !editorTabMovesFocus && !inSnippetMode && testagent.autocomplete.enableSmartInlineTaskKeybinding && github.copilot.completions.enabled"
      }
    ],
    "configuration": {
      "title": "TestAgent",
      "properties": {
        "testagent.new.language": {
          "type": "string",
          "default": "",
          "description": "Override the UI language for TestAgent (e.g. en, de, ja). Empty means use VS Code's display language.",
          "enum": [
            "",
            "en",
            "zh",
            "zht",
            "ko",
            "de",
            "es",
            "fr",
            "da",
            "ja",
            "pl",
            "ru",
            "ar",
            "no",
            "br",
            "th",
            "bs",
            "tr",
            "nl",
            "uk"
          ],
          "enumDescriptions": [
            "Auto (VS Code language)",
            "English",
            "简体中文",
            "繁體中文",
            "한국어",
            "Deutsch",
            "Español",
            "Français",
            "Dansk",
            "日本語",
            "Polski",
            "Русский",
            "العربية",
            "Norsk",
            "Português (Brasil)",
            "ภาษาไทย",
            "Bosanski",
            "Türkçe",
            "Nederlands",
            "Українська"
          ]
        },
        "testagent.new.model.providerID": {
          "type": "string",
          "default": "内置model",
          "description": "内置model"
        },
        "testagent.new.model.modelID": {
          "type": "string",
          "default": "内置model",
          "description": "内置model"
        },
        "testagent.new.autocomplete.enableAutoTrigger": {
          "type": "boolean",
          "default": true,
          "description": "Enable automatic inline completion suggestions"
        },
        "testagent.new.autocomplete.enableSmartInlineTaskKeybinding": {
          "type": "boolean",
          "default": false,
          "description": "Enable smart inline task keybinding"
        },
        "testagent.new.autocomplete.enableChatAutocomplete": {
          "type": "boolean",
          "default": false,
          "description": "Enable chat textarea autocomplete"
        },
        "testagent.new.claudeCodeCompat": {
          "type": "boolean",
          "default": false,
          "description": "Load CLAUDE.md instructions and skills from your Claude Code configuration directory into TestAgent sessions. Enable this if you want TestAgent to use your Claude Code instructions and skills."
        },
        "testagent.new.browserAutomation.enabled": {
          "type": "boolean",
          "default": false,
          "description": "Enable browser automation powered by Playwright. When enabled, the AI agent can interact with web pages in a visible Chrome window."
        },
        "testagent.new.browserAutomation.useSystemChrome": {
          "type": "boolean",
          "default": true,
          "description": "Use your system's installed Chrome browser instead of downloading a separate Chromium instance."
        },
        "testagent.new.browserAutomation.headless": {
          "type": "boolean",
          "default": false,
          "description": "Run browser automation in headless mode (no visible window). When disabled, you can watch the agent interact with the browser."
        },
        "testagent.new.notifications.agent": {
          "type": "boolean",
          "default": true,
          "description": "Show notification when agent completes a task"
        },
        "testagent.new.notifications.permissions": {
          "type": "boolean",
          "default": true,
          "description": "Show notification on permission requests"
        },
        "testagent.new.notifications.errors": {
          "type": "boolean",
          "default": true,
          "description": "Show notification on errors"
        },
        "testagent.new.sounds.agent": {
          "type": "string",
          "default": "default",
          "enum": [
            "default",
            "none"
          ],
          "description": "Sound to play when agent completes"
        },
        "testagent.new.sounds.permissions": {
          "type": "string",
          "default": "default",
          "enum": [
            "default",
            "none"
          ],
          "description": "Sound to play on permission requests"
        },
        "testagent.new.sounds.errors": {
          "type": "string",
          "default": "default",
          "enum": [
            "default",
            "none"
          ],
          "description": "Sound to play on errors"
        },
        "testagent.new.showTaskTimeline": {
          "type": "boolean",
          "default": true,
          "description": "Show the task timeline graph in the chat header"
        }
      }
    }
  },
  "scripts": {
    "prepare:cli-binary": "bun script/local-bin.ts",
    "compile": "bun run prepare:cli-binary -- --force && bun run rebuild-sdk && bun run typecheck && bun run lint && node esbuild.js",
    "watch": "bun run rebuild-sdk && bun run --parallel watch:esbuild watch:tsc",
    "watch:esbuild": "bun run prepare:cli-binary && node esbuild.js --watch",
    "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
    "watch:cli": "bun script/watch-cli.ts",
    "package": "bun run prepare:cli-binary && bun run rebuild-sdk && bun run typecheck && bun run lint && node esbuild.js --production",
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    "pretest": "bun run compile-tests && bun run compile && bun run lint",
    "check-types": "tsc --noEmit",
    "check-types:webview": "bun script/typecheck.ts --project webview-ui/tsconfig.json",
    "typecheck": "bun run check-types:extension && bun run check-types:webview",
    "check-types:extension": "bun script/typecheck.ts",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "knip": "knip",
    "check-kilocode-change": "! grep -rn 'kilocode_change' . ../kilo-ui/ --exclude='package.json' --exclude='*.md' --exclude-dir='node_modules' --exclude-dir='dist' | grep -v '`kilocode_change`'",
    "lint": "eslint src webview-ui",
    "test": "vscode-test",
    "test:unit": "bun test tests/unit/",
    "rebuild-sdk": "bun run --cwd ../sdk/js build",
    "storybook": "storybook dev -p 6007",
    "build-storybook": "storybook build -o storybook-static",
    "test:visual": "playwright test",
    "test:visual:update": "playwright test --update-snapshots",
    "snapshot:build": "bun script/dev-snapshot.ts build",
    "snapshot:install": "bun script/dev-snapshot.ts install",
    "extension": "bun script/launch.ts",
    "testagent:vsix": "bun run rebuild-sdk && bun run typecheck && bun run lint && node esbuild.js --production && vsce package --no-dependencies"
  },
  "devDependencies": {
    "@playwright/test": "1.57.0",
    "@storybook/addon-docs": "10.2.10",
    "@types/diff": "^6.0.0",
    "@types/mocha": "^10.0.10",
    "@types/node": "22.x",
    "@types/qrcode": "^1.5.6",
    "@types/vscode": "^1.105.1",
    "@vscode/test-cli": "^0.0.12",
    "@vscode/test-electron": "^2.5.2",
    "@vscode/vsce": "^3.7.1",
    "esbuild": "^0.27.2",
    "esbuild-plugin-solid": "^0.6.0",
    "eslint": "^9.39.2",
    "eslint-config-prettier": "^10.1.8",
    "knip": "5.85.0",
    "prettier": "3.6.2",
    "qrcode": "^1.5.4",
    "storybook": "10.2.10",
    "storybook-solidjs-vite": "10.0.9",
    "ts-morph": "27.0.2",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.54.0",
    "vite": "7.3.2",
    "vite-plugin-solid": "2.11.10"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@kilocode/kilo-i18n": "workspace:*",
    "@kilocode/kilo-ui": "workspace:*",
    "@kilocode/sdk": "workspace:*",
    "@opencode-ai/ui": "workspace:*",
    "@thisbeyond/solid-dnd": "0.7.5",
    "diff": "8.0.4",
    "dotenv": "^16.4.7",
    "fastest-levenshtein": "^1.0.16",
    "friendly-words": "1.3.1",
    "ignore": "^7.0.3",
    "js-tiktoken": "^1.0.18",
    "jsonc-parser": "3.3.1",
    "lru-cache": "^11.0.2",
    "openai": "^4.85.4",
    "quick-lru": "^7.0.0",
    "simple-git": "3.35.2",
    "solid-js": "^1.9.11",
    "stream-chat": "9.38.0",
    "uri-js": "^4.4.1",
    "virtua": "catalog:",
    "web-tree-sitter": "^0.24.7",
    "yaml": "2.8.3",
    "zod": "^3.24.2"
  }
}
===
{
  "name": "testagent-tscode",
  "displayName": "TestAgent for TScode",
  "description": "TestAgent Code Extension",
  "version": "1.0.4",
  "icon": "assets/icons/logo-outline-black.png",
  "galleryBanner": {
    "color": "#FFFFFF",
    "theme": "light"
  },
  "publisher": "testagent",
  "repository": {
    "type": "git",
    "url": "https://github.com/Kilo-Org/kilocode.git",
    "directory": "packages/kilo-vscode"
  },
  "engines": {
    "vscode": "^1.105.1"
  },
  "license": "MIT",
  "author": {
    "name": "TestAgent"
  },
  "categories": [
    "AI",
    "Chat",
    "Programming Languages",
    "Education",
    "Snippets",
    "Testing"
  ],
  "keywords": [
    "kilo",
    "claude",
    "dev",
    "mcp",
    "openrouter",
    "coding",
    "agent",
    "autonomous",
    "chatgpt",
    "sonnet",
    "ai",
    "llama",
    "TestAgent",
    "kilocode"
  ],
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "taskDefinitions": [
      {
        "type": "kilo-worktree-setup",
        "properties": {
          "script": {
            "type": "string",
            "description": "The setup script command to execute"
          }
        }
      }
    ],
    "viewsContainers": {
      "secondarySidebar": [
        {
          "id": "testagent-ActivityBar",
          "title": "TestAgent",
          "icon": "assets/icons/ghost-svgrepo-com.svg"
        }
      ]
    },
    "views": {
      "testagent-ActivityBar": [
        {
          "type": "webview",
          "id": "testagent.SidebarProvider",
          "name": "TestAgent"
        }
      ]
    },
    "commands": [
      {
        "command": "testagent.new.plusButtonClicked",
        "title": "新建任务",
        "icon": "$(add)"
      },
      {
        "command": "testagent.new.historyButtonClicked",
        "title": "历史会话",
        "icon": "$(history)"
      },
      {
        "command": "testagent.new.settingsButtonClicked",
        "title": "设置",
        "icon": "$(settings-gear)"
      },
      {
        "command": "testagent.new.openInTab",
        "title": "TestAgent",
        "icon": {
          "light": "assets/icons/kilo-light.png",
          "dark": "assets/icons/kilo-dark.png"
        }
      },
      {
        "command": "testagent.new.showChanges",
        "title": "Show Changes",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.openMigrationWizard",
        "title": "Migrate Settings from Legacy Version",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.autocomplete.generateSuggestions",
        "title": "Generate Suggested Edits",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.autocomplete.cancelSuggestions",
        "title": "Cancel Suggested Edits",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.previousSession",
        "title": "Agent Manager: Previous Session",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.nextSession",
        "title": "Agent Manager: Next Session",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.previousTab",
        "title": "Agent Manager: Previous Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.nextTab",
        "title": "Agent Manager: Next Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.showTerminal",
        "title": "Agent Manager: Focus Terminal",
        "category": "TestAgent",
        "icon": "$(terminal)"
      },
      {
        "command": "testagent.new.agentManager.runScript",
        "title": "Agent Manager: Run Script",
        "category": "Kilo Code",
        "icon": "$(play)"
      },
      {
        "command": "testagent.new.agentManager.toggleDiff",
        "title": "Agent Manager: Toggle Diff Panel",
        "category": "TestAgent",
        "icon": "$(diff)"
      },
      {
        "command": "testagent.new.agentManager.showShortcuts",
        "title": "Agent Manager: Show Keyboard Shortcuts",
        "category": "TestAgent",
        "icon": "$(keyboard)"
      },
      {
        "command": "testagent.new.agentManager.newTab",
        "title": "Agent Manager: New Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.closeTab",
        "title": "Agent Manager: Close Tab",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.newWorktree",
        "title": "Agent Manager: New Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.openWorktree",
        "title": "Agent Manager: Open Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.closeWorktree",
        "title": "Agent Manager: Close Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.advancedWorktree",
        "title": "Agent Manager: Advanced New Worktree",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo1",
        "title": "Agent Manager: Jump to Item 1",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo2",
        "title": "Agent Manager: Jump to Item 2",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo3",
        "title": "Agent Manager: Jump to Item 3",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo4",
        "title": "Agent Manager: Jump to Item 4",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo5",
        "title": "Agent Manager: Jump to Item 5",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo6",
        "title": "Agent Manager: Jump to Item 6",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo7",
        "title": "Agent Manager: Jump to Item 7",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo8",
        "title": "Agent Manager: Jump to Item 8",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.agentManager.jumpTo9",
        "title": "Agent Manager: Jump to Item 9",
        "category": "TestAgent"
      },

      {
        "command": "testagent.new.explainCode",
        "title": "Explain Code",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.fixCode",
        "title": "Fix Code",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.improveCode",
        "title": "Improve Code",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.addToContext",
        "title": "Add to Context",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.terminalAddToContext",
        "title": "Add Terminal Content to Context",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.terminalFixCommand",
        "title": "Fix This Command",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.terminalExplainCommand",
        "title": "Explain This Command",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.focusChatInput",
        "title": "Focus Chat Input",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.cycleAgentMode",
        "title": "Cycle Agent Mode",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.cyclePreviousAgentMode",
        "title": "Cycle Previous Agent Mode",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.toggleAutoApprove",
        "title": "Toggle Auto-Approve",
        "category": "TestAgent"
      },
      {
        "command": "testagent.new.generateTerminalCommand",
        "title": "Generate Terminal Command",
        "category": "TestAgent"
      }
    ],
    "submenus": [
      {
        "id": "testagent.new.editorContextMenu",
        "label": "TestAgent"
      },
      {
        "id": "testagent.new.terminalContextMenu",
        "label": "TestAgent"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "testagent.new.plusButtonClicked",
          "group": "navigation@0",
          "when": "view == testagent.SidebarProvider"
        },
        {
          "command": "testagent.new.historyButtonClicked",
          "group": "navigation@1",
          "when": "view == testagent.SidebarProvider"
        },
        {
          "command": "testagent.new.settingsButtonClicked",
          "group": "navigation@5",
          "when": "view == testagent.SidebarProvider"
        }
      ],
      "editor/title": [
        {
          "command": "testagent.new.plusButtonClicked",
          "group": "navigation@0",
          "when": "activeWebviewPanelId == testagent.new.TabPanel"
        },
        {
          "command": "testagent.new.historyButtonClicked",
          "group": "navigation@1",
          "when": "activeWebviewPanelId == testagent.new.TabPanel"
        },
        {
          "command": "testagent.new.settingsButtonClicked",
          "group": "navigation@3",
          "when": "activeWebviewPanelId == testagent.new.TabPanel"
        }
      ],
      "editor/context": [
        {
          "submenu": "testagent.new.editorContextMenu",
          "group": "1_testagent"
        }
      ],
      "testagent.new.editorContextMenu": [
        {
          "command": "testagent.new.explainCode",
          "group": "1_actions@1"
        },
        {
          "command": "testagent.new.fixCode",
          "group": "1_actions@2"
        },
        {
          "command": "testagent.new.improveCode",
          "group": "1_actions@3"
        },
        {
          "command": "testagent.new.addToContext",
          "group": "1_actions@4"
        }
      ],
      "terminal/context": [
        {
          "submenu": "testagent.new.terminalContextMenu",
          "group": "2_testagent"
        }
      ],
      "testagent.new.terminalContextMenu": [
        {
          "command": "testagent.new.terminalAddToContext",
          "group": "1_actions@1"
        },
        {
          "command": "testagent.new.terminalFixCommand",
          "group": "1_actions@2"
        },
        {
          "command": "testagent.new.terminalExplainCommand",
          "group": "1_actions@3"
        }
      ]
    },
    "keybindings": [
      {
        "command": "testagent.new.focusChatInput",
        "key": "ctrl+shift+a",
        "mac": "cmd+shift+a"
      },
      {
        "command": "testagent.new.toggleAutoApprove",
        "key": "ctrl+alt+a",
        "mac": "cmd+alt+a"
      },
      {
        "command": "testagent.new.generateTerminalCommand",
        "key": "ctrl+shift+g",
        "mac": "cmd+shift+g"
      },
      
      {
        "command": "testagent.new.addToContext",
        "key": "ctrl+k ctrl+a",
        "mac": "cmd+k cmd+a",
        "when": "editorTextFocus && editorHasSelection"
      },
      {
        "command": "testagent.new.cycleAgentMode",
        "key": "ctrl+.",
        "mac": "cmd+.",
        "when": "sideBarFocus && testagent.new.sidebarVisible || activeWebviewPanelId == 'testagent.new.AgentManagerPanel' || activeWebviewPanelId == 'testagent.new.TabPanel'"
      },
      {
        "command": "testagent.new.cyclePreviousAgentMode",
        "key": "ctrl+shift+.",
        "mac": "cmd+shift+.",
        "when": "sideBarFocus && testagent.new.sidebarVisible || activeWebviewPanelId == 'testagent.new.AgentManagerPanel' || activeWebviewPanelId == 'testagent.new.TabPanel'"
      },
      {
        "command": "testagent.new.autocomplete.cancelSuggestions",
        "key": "escape",
        "when": "editorTextFocus && !editorTabMovesFocus && !inSnippetMode && testagent.new.autocomplete.hasSuggestions"
      },
      {
        "command": "testagent.new.autocomplete.generateSuggestions",
        "key": "ctrl+l",
        "mac": "cmd+l",
        "when": "editorTextFocus && !editorTabMovesFocus && !inSnippetMode && testagent.autocomplete.enableSmartInlineTaskKeybinding && !github.copilot.completions.enabled"
      },
      {
        "command": "testagent.new.autocomplete.showIncompatibilityExtensionPopup",
        "key": "ctrl+l",
        "mac": "cmd+l",
        "when": "editorTextFocus && !editorTabMovesFocus && !inSnippetMode && testagent.autocomplete.enableSmartInlineTaskKeybinding && github.copilot.completions.enabled"
      }
    ],
    "configuration": {
      "title": "TestAgent",
      "properties": {
        "testagent.new.language": {
          "type": "string",
          "default": "",
          "description": "Override the UI language for TestAgent (e.g. en, de, ja). Empty means use VS Code's display language.",
          "enum": [
            "",
            "en",
            "zh",
            "zht",
            "ko",
            "de",
            "es",
            "fr",
            "da",
            "ja",
            "pl",
            "ru",
            "ar",
            "no",
            "br",
            "th",
            "bs",
            "tr",
            "nl",
            "uk"
          ],
          "enumDescriptions": [
            "Auto (VS Code language)",
            "English",
            "简体中文",
            "繁體中文",
            "한국어",
            "Deutsch",
            "Español",
            "Français",
            "Dansk",
            "日本語",
            "Polski",
            "Русский",
            "العربية",
            "Norsk",
            "Português (Brasil)",
            "ภาษาไทย",
            "Bosanski",
            "Türkçe",
            "Nederlands",
            "Українська"
          ]
        },
        "testagent.new.model.providerID": {
          "type": "string",
          "default": "内置model",
          "description": "内置model"
        },
        "testagent.new.model.modelID": {
          "type": "string",
          "default": "内置model",
          "description": "内置model"
        },
        "testagent.new.autocomplete.enableAutoTrigger": {
          "type": "boolean",
          "default": true,
          "description": "Enable automatic inline completion suggestions"
        },
        "testagent.new.autocomplete.enableSmartInlineTaskKeybinding": {
          "type": "boolean",
          "default": false,
          "description": "Enable smart inline task keybinding"
        },
        "testagent.new.autocomplete.enableChatAutocomplete": {
          "type": "boolean",
          "default": false,
          "description": "Enable chat textarea autocomplete"
        },
        "testagent.new.claudeCodeCompat": {
          "type": "boolean",
          "default": false,
          "description": "Load CLAUDE.md instructions and skills from your Claude Code configuration directory into TestAgent sessions. Enable this if you want TestAgent to use your Claude Code instructions and skills."
        },
        "testagent.new.browserAutomation.enabled": {
          "type": "boolean",
          "default": false,
          "description": "Enable browser automation powered by Playwright. When enabled, the AI agent can interact with web pages in a visible Chrome window."
        },
        "testagent.new.browserAutomation.useSystemChrome": {
          "type": "boolean",
          "default": true,
          "description": "Use your system's installed Chrome browser instead of downloading a separate Chromium instance."
        },
        "testagent.new.browserAutomation.headless": {
          "type": "boolean",
          "default": false,
          "description": "Run browser automation in headless mode (no visible window). When disabled, you can watch the agent interact with the browser."
        },
        "testagent.new.notifications.agent": {
          "type": "boolean",
          "default": true,
          "description": "Show notification when agent completes a task"
        },
        "testagent.new.notifications.permissions": {
          "type": "boolean",
          "default": true,
          "description": "Show notification on permission requests"
        },
        "testagent.new.notifications.errors": {
          "type": "boolean",
          "default": true,
          "description": "Show notification on errors"
        },
        "testagent.new.sounds.agent": {
          "type": "string",
          "default": "default",
          "enum": [
            "default",
            "none"
          ],
          "description": "Sound to play when agent completes"
        },
        "testagent.new.sounds.permissions": {
          "type": "string",
          "default": "default",
          "enum": [
            "default",
            "none"
          ],
          "description": "Sound to play on permission requests"
        },
        "testagent.new.sounds.errors": {
          "type": "string",
          "default": "default",
          "enum": [
            "default",
            "none"
          ],
          "description": "Sound to play on errors"
        },
        "testagent.new.showTaskTimeline": {
          "type": "boolean",
          "default": true,
          "description": "Show the task timeline graph in the chat header"
        }
      }
    }
  },
  "scripts": {
    "prepare:cli-binary": "bun script/local-bin.ts",
    "compile": "bun run prepare:cli-binary -- --force && bun run rebuild-sdk && bun run typecheck && bun run lint && node esbuild.js",
    "watch": "bun run rebuild-sdk && bun run --parallel watch:esbuild watch:tsc",
    "watch:esbuild": "bun run prepare:cli-binary && node esbuild.js --watch",
    "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
    "watch:cli": "bun script/watch-cli.ts",
    "package": "bun run prepare:cli-binary && bun run rebuild-sdk && bun run typecheck && bun run lint && node esbuild.js --production",
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    "pretest": "bun run compile-tests && bun run compile && bun run lint",
    "check-types": "tsc --noEmit",
    "check-types:webview": "bun script/typecheck.ts --project webview-ui/tsconfig.json",
    "typecheck": "bun run check-types:extension && bun run check-types:webview",
    "check-types:extension": "bun script/typecheck.ts",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "knip": "knip",
    "check-kilocode-change": "! grep -rn 'kilocode_change' . ../kilo-ui/ --exclude='package.json' --exclude='*.md' --exclude-dir='node_modules' --exclude-dir='dist' | grep -v '`kilocode_change`'",
    "lint": "eslint src webview-ui",
    "test": "vscode-test",
    "test:unit": "bun test tests/unit/",
    "rebuild-sdk": "bun run --cwd ../sdk/js build",
    "storybook": "storybook dev -p 6007",
    "build-storybook": "storybook build -o storybook-static",
    "test:visual": "playwright test",
    "test:visual:update": "playwright test --update-snapshots",
    "snapshot:build": "bun script/dev-snapshot.ts build",
    "snapshot:install": "bun script/dev-snapshot.ts install",
    "extension": "bun script/launch.ts",
    "testagent:vsix": "bun run rebuild-sdk && bun run typecheck && bun run lint && node esbuild.js --production && vsce package --no-dependencies",
    "testagent-nodejs:vsix": "bun script/package-nodejs-server.ts"
  },
  "devDependencies": {
    "@playwright/test": "1.57.0",
    "@storybook/addon-docs": "10.2.10",
    "@types/diff": "^6.0.0",
    "@types/mocha": "^10.0.10",
    "@types/node": "22.x",
    "@types/qrcode": "^1.5.6",
    "@types/vscode": "^1.105.1",
    "@vscode/test-cli": "^0.0.12",
    "@vscode/test-electron": "^2.5.2",
    "@vscode/vsce": "^3.7.1",
    "esbuild": "^0.27.2",
    "esbuild-plugin-solid": "^0.6.0",
    "eslint": "^9.39.2",
    "eslint-config-prettier": "^10.1.8",
    "knip": "5.85.0",
    "prettier": "3.6.2",
    "qrcode": "^1.5.4",
    "storybook": "10.2.10",
    "storybook-solidjs-vite": "10.0.9",
    "ts-morph": "27.0.2",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.54.0",
    "vite": "7.3.2",
    "vite-plugin-solid": "2.11.10"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@kilocode/kilo-i18n": "workspace:*",
    "@kilocode/kilo-ui": "workspace:*",
    "@kilocode/sdk": "workspace:*",
    "@opencode-ai/ui": "workspace:*",
    "@thisbeyond/solid-dnd": "0.7.5",
    "diff": "8.0.4",
    "dotenv": "^16.4.7",
    "fastest-levenshtein": "^1.0.16",
    "friendly-words": "1.3.1",
    "ignore": "^7.0.3",
    "js-tiktoken": "^1.0.18",
    "jsonc-parser": "3.3.1",
    "lru-cache": "^11.0.2",
    "openai": "^4.85.4",
    "quick-lru": "^7.0.0",
    "simple-git": "3.35.2",
    "solid-js": "^1.9.11",
    "stream-chat": "9.38.0",
    "uri-js": "^4.4.1",
    "virtua": "catalog:",
    "web-tree-sitter": "^0.24.7",
    "yaml": "2.8.3",
    "zod": "^3.24.2"
  }
}
```

- 新增 `opencode:vsix` 打包脚本

#### 6. [index.ts](file:///Users/lujs/testagent-kilo/packages/kilo-vscode/src/services/cli-backend/index.ts)
```diff:index.ts
// Main exports for cli-backend services

export type { KilocodeNotification } from "./types"

export { KiloConnectionService } from "./connection-service"
export { ServerStartupError } from "./server-manager"
===
// Main exports for cli-backend services

export type { KilocodeNotification } from "./types"

export { KiloConnectionService } from "./connection-service"
export { ServerStartupError } from "./server-manager"
export { NodeServerManager } from "./node-server-manager"
export { runtime, isTestagentBun, isTestagentNodejs } from "./runtime"
```

- 导出 `NodeServerManager`、`runtime`、`isTestagentBun`、`isTestagentNodejs`

---

## 使用方式

### 构建 testagent 版本（默认，现有行为）

```bash
cd packages/kilo-vscode
node esbuild.js --production       # BACKEND_RUNTIME 默认为 "testagent-bun"
vsce package --no-dependencies     # → testagent-tscode-1.0.4.vsix
```

### 构建 opencode 版本

```bash
cd packages/kilo-vscode

# 方式 1: 使用打包脚本（推荐，一键完成）
bun script/package-nodejs-server.ts

# 方式 2: 手动步骤
BACKEND_RUNTIME=testagent-nodejs node esbuild.js --production
vsce package --no-dependencies -o testagent-nodejs-tscode.vsix
```

### Node.js 服务端准备

opencode 版本需要提前将 `opencode-server` 的 dist 拷贝到扩展目录：

```bash
# 构建 opencode-server
cd packages/testagent-core/packages/opencode-server
bun run build

# 拷贝到扩展目录
cp -r dist/ ../../packages/kilo-vscode/opencode-server/
cd ../../packages/kilo-vscode/opencode-server/
npm install --omit=dev  # 安装 node-pty 原生绑定
```

> `bun script/package-nodejs-server.ts` 会自动完成以上步骤。

---

## 架构原理

```
esbuild define: BACKEND_RUNTIME = "testagent-nodejs"
            ↓
runtime.ts: isTestagentBun() → false, isTestagentNodejs() → true
            ↓
connection-service.ts:
  this.serverManager = new NodeServerManager(context)  ✅
  this.serverManager = new ServerManager(context)      ❌ (dead code eliminated)
            ↓
extension.ts:
  TelemetryProxy     → null     (跳过)
  RemoteStatusService → null    (跳过)
  syncUserId()        → 跳过    (无 /kilocode/testagent/user)
  drainSuggestions()  → 跳过    (无 suggestion.* API)
  drainNetworkWaits() → 跳过    (无 network.* API)
```

## Node.js 版本要求

- **最低**: Node.js >= 22.5.0（支持 `node:sqlite`）
- `NodeServerManager` 会自动在系统 PATH 中查找 `node`
- 如果版本不够或未找到，会提示用户安装

## 下一步

> [!NOTE]
> 以下是可选的后续优化：

1. **CI 构建矩阵** — 在 GitHub Actions 中同时构建两个版本
2. **VS Code Marketplace** — 考虑是否上传两个独立扩展
3. **更多 Kilo API 降级** — 检查 `KiloProvider.ts` 中是否有更多 `kilo.*` 调用需要条件化
4. **Windows 测试** — `node-pty` 在 Windows 上的原生绑定需要验证
