#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"
import { cpSync, mkdirSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs"

const kiloVscodeDir = join(import.meta.dir, "..")
const testflowDir = join(kiloVscodeDir, "..", "testflow")
const binDir = join(kiloVscodeDir, "bin")

function log(msg: string) {
  console.log(`[build-testflow] ${msg}`)
}

// testagent_change - support target platform argument (wrapper 形态按目标平台生成)
//   bundle 本身是跨平台 JS，但 CLI wrapper 是平台特定的（Windows 用 .cmd，其余用 sh 脚本）。
const targetArg = process.argv.find((arg: string) => arg.startsWith("--target="))
const targetPlatform = targetArg ? targetArg.split("=")[1] : undefined

// testagent_change - support build mode argument (production or dev)
const modeArg = process.argv.find((arg: string) => arg.startsWith("--env="))
const buildEnv = modeArg ? (modeArg.split("=")[1] || "production") : "production"

if (!targetPlatform) {
  throw new Error("--target= argument is required. Use: linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64")
}

if (!["production", "dev"].includes(buildEnv)) {
  throw new Error(`Invalid build mode: ${buildEnv}. Use: production or dev`)
}

const supportedTargets = [
  "linux-x64", "linux-arm64", "alpine-x64", "alpine-arm64",
  "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64",
]
if (!supportedTargets.includes(targetPlatform)) {
  throw new Error(
    `Unsupported target platform: ${targetPlatform}. Supported: ${supportedTargets.join(", ")}`
  )
}
const isWindowsTarget = targetPlatform.startsWith("win32-")

// JS 单文件天然跨平台，不再需要按平台编译。产物为单个 testflow.mjs，由各平台 VSIX 共用。
const testflowMjs = join(binDir, "testflow.mjs")
const testflowResDir = join(binDir, "testflow-res")

log(`Building testflow JS bundle, mode: ${buildEnv}`)

// 1. build testflow dist (tsc) —— 先产出 dist/，@/ 别名由 tsc-alias 重写为相对路径
log(`Building testflow dist (${buildEnv} mode)...`)
const buildScript = buildEnv === "dev" ? "build:dev" : "build"
await $`bun run ${buildScript}`.cwd(testflowDir)

// 2. bundle 成单个 ESM JS 文件（运行在 Node 上，不嵌入运行时）
//    --target=node 让 bun build 自动注入 createRequire 兜底 CJS 动态 require，无需额外 banner。
log(`Bundling testflow.mjs (target=node, minify)...`)
await $`bun build dist/cli-entry.js --target=node --minify --outfile ${testflowMjs}`.cwd(testflowDir)

// 3. copy resource files (templates + config) next to the bundle
log("Copying testflow resources...")
if (existsSync(testflowResDir)) rmSync(testflowResDir, { recursive: true })
mkdirSync(testflowResDir, { recursive: true })
cpSync(join(testflowDir, "dist", "config"), join(testflowResDir, "config"), { recursive: true })
cpSync(join(testflowDir, "dist", "templates"), join(testflowResDir, "templates"), { recursive: true })
// 环境打包拷贝env文件
const sourceEnvFile = buildEnv === "dev"
  ? "env.dev.yaml"
  : "env.production.yaml"

cpSync(
  join(testflowDir, "dist", sourceEnvFile),
  join(testflowResDir, "env.yaml"),
)

// 4. 生成 CLI wrapper：让终端可直接敲 `testflow` 调用 bundle。
//    扩展侧不走此 wrapper（三处均为 spawn('node', [testflow.mjs, ...])），仅为终端手动调用提供便利。
//    JS bundle 本身仍单文件跨平台。
log(`Writing testflow CLI wrapper (target=${targetPlatform})...`)
if (isWindowsTarget) {
  // %~dp0 = 该 .cmd 文件所在目录（带尾部 \），无论从何处调用都能定位同目录的 testflow.mjs
  const cmdContent = "@echo off\r\nnode \"%~dp0testflow.mjs\" %*\r\n"
  writeFileSync(join(binDir, "testflow.cmd"), cmdContent, "utf8")
} else {
  // $(dirname "$0") = 脚本自身所在目录；shebang + 可执行位让 `./testflow` 直接可用
  // 内容是通用 POSIX sh，linux/alpine/darwin 目标共用
  const shContent = "#!/bin/sh\nnode \"$(dirname \"$0\")/testflow.mjs\" \"$@\"\n"
  const shPath = join(binDir, "testflow")
  writeFileSync(shPath, shContent, "utf8")
  chmodSync(shPath, 0o755)
}

log(`✅ Done. Bundle: ${testflowMjs}`)
