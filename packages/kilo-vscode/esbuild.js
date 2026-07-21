const esbuild = require("esbuild")
const path = require("path")
const { solidPlugin } = require("esbuild-plugin-solid")

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

// Backend runtime selection: "testagent-bun" (Bun binary) or "testagent-nodejs" (Node.js)
// Set via BACKEND_RUNTIME env var at build time. Defaults to "testagent-bun".
const backendRuntime = process.env.BACKEND_RUNTIME || "testagent-bun"
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
 * Resolve the synthetic `kilo-shiki-worker` entry point to Pierre's Shiki worker
 * so esbuild can bundle it (and its inlined oniguruma WebAssembly) into a single
 * `dist/shiki-worker.js` asset loaded by `webview-ui/pierre-worker.ts`. Switch to
 * `worker-portable.js` to drop WebAssembly and use the JS regex engine instead.
 *
 * @type {import('esbuild').Plugin}
 */
const shikiWorkerEntryPlugin = {
  name: "shiki-worker-entry",
  setup(build) {
    build.onResolve({ filter: /^kilo-shiki-worker$/ }, async () => {
      const resolved = await build.resolve("@pierre/diffs/worker/worker.js", {
        kind: "import-statement",
        resolveDir: __dirname,
      })
      if (resolved.errors.length > 0) return { errors: resolved.errors }
      return { path: resolved.path }
    })
  },
}

/**
 * Route the shared `@opencode-ai/ui/pierre/worker` module (and its relative
 * variants) to the Kilo implementation in `webview-ui/pierre-worker.ts`.
 *
 * The upstream module loads Pierre's Shiki worker via a Vite-only
 * `?worker&url` import that esbuild can't resolve. The Kilo replacement loads
 * the worker from the bundled `dist/shiki-worker.js` asset instead, so syntax
 * highlighting runs off the main thread. `@pierre/diffs/worker` (used by that
 * replacement) is left alone.
 *
 * @type {import('esbuild').Plugin}
 */
const pierreWorkerAliasPlugin = {
  name: "pierre-worker-alias",
  setup(build) {
    build.onResolve({ filter: /pierre\/worker$/ }, (args) => {
      if (args.path.includes("@pierre")) return
      return { path: path.join(__dirname, "webview-ui", "pierre-worker.ts") }
    })
  },
}

const svgSpritePlugin = {
  name: "svg-sprite-inline",
  setup(build) {
    build.onLoad({ filter: /sprite\.svg$/ }, (args) => {
      const content = require("fs").readFileSync(args.path, "utf8")
      // Extract each <symbol id="X" viewBox="..."> ... </symbol>
      const symbols = {}
      const re = /<symbol\s+([^>]*?)id="([^"]+)"([^>]*?)>([\s\S]*?)<\/symbol>/g
      let m
      while ((m = re.exec(content)) !== null) {
        const id = m[2]
        const attrs = m[1] + " " + m[3]
        const vb = attrs.match(/viewBox="([^"]+)"/)?.[1] || "0 0 16 16"
        symbols[id] = { viewBox: vb, content: m[4] }
      }
      return {
        contents: `
          const symbols = ${JSON.stringify(symbols)};
          export function getIcon(id) { return symbols[id]; }
          export default symbols;
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
      pierreWorkerAliasPlugin,
      svgSpritePlugin,
      cssPackageResolvePlugin,
      solidPlugin(),
      esbuildProblemMatcherPlugin,
    ],
  })
}

// Bundle Pierre's Shiki worker into a single self-contained asset that the
// webviews load off the main thread for syntax highlighting.
function createShikiWorkerContext() {
  return esbuild.context({
    entryPoints: ["kilo-shiki-worker"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/shiki-worker.js",
    logLevel: "silent",
    plugins: [shikiWorkerEntryPlugin, esbuildProblemMatcherPlugin],
  })
}

async function main() {
  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minifyIdentifiers: false,
    minifySyntax: production,
    minifyWhitespace: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    define: {
      BACKEND_RUNTIME: JSON.stringify(backendRuntime),
    },
    mainFields: ["module", "main"],
    conditions: ["node"],
    plugins: [jsoncParserEsmPlugin, esbuildProblemMatcherPlugin],
  })

  // Build Agent Manager webview (SolidJS, shares components with sidebar)
  const agentManagerCtx = await createBrowserWebviewContext(
    "webview-ui/agent-manager/index.tsx",
    "dist/agent-manager.js",
  )

  // Build Diff Viewer webview (SolidJS, reuses Agent Manager diff components)
  const diffViewerCtx = await createBrowserWebviewContext("webview-ui/diff-viewer/index.tsx", "dist/diff-viewer.js")

  // Build Diff Virtual webview (lightweight single-file diff for permission approval)
  const diffVirtualCtx = await createBrowserWebviewContext("webview-ui/diff-virtual/index.tsx", "dist/diff-virtual.js")

  // Build webview
  const webviewCtx = await createBrowserWebviewContext("webview-ui/src/index.tsx", "dist/webview.js")

  // Build the shared Shiki highlighting worker asset
  const shikiWorkerCtx = await createShikiWorkerContext()

  if (watch) {
    await Promise.all([
      extensionCtx.watch(),
      webviewCtx.watch(),
      agentManagerCtx.watch(),
      diffViewerCtx.watch(),
      diffVirtualCtx.watch(),
      shikiWorkerCtx.watch(),
    ])
  } else {
    await Promise.all([
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
      agentManagerCtx.rebuild(),
      diffViewerCtx.rebuild(),
      diffVirtualCtx.rebuild(),
      shikiWorkerCtx.rebuild(),
    ])
    await Promise.all([
      extensionCtx.dispose(),
      webviewCtx.dispose(),
      agentManagerCtx.dispose(),
      diffViewerCtx.dispose(),
      diffVirtualCtx.dispose(),
      shikiWorkerCtx.dispose(),
    ])
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
