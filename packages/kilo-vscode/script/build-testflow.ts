#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs"

const kiloVscodeDir = join(import.meta.dir, "..")
const testflowDir = join(kiloVscodeDir, "..", "testflow")
const binDir = join(kiloVscodeDir, "bin")

function log(msg: string) {
  console.log(`[build-testflow] ${msg}`)
}

// testagent_change - support target platform argument (same pattern as package-nodejs-server.ts)
const targetArg = process.argv.find((arg: string) => arg.startsWith("--target="))
const targetPlatform = targetArg ? targetArg.split("=")[1] : undefined

if (!targetPlatform) {
  throw new Error("--target= argument is required. Use: linux-x64, linux-arm64, alpine-x64, alpine-arm64, darwin-x64, darwin-arm64, win32-x64")
}

// Map VS Code target to Bun compile target
const targetMap: Record<string, { target: string; binaryName: string }> = {
  "linux-x64": { target: "bun-linux-x64", binaryName: "testflow" },
  "linux-arm64": { target: "bun-linux-arm64", binaryName: "testflow" },
  "alpine-x64": { target: "bun-linux-x64", binaryName: "testflow" },
  "alpine-arm64": { target: "bun-linux-arm64", binaryName: "testflow" },
  "darwin-x64": { target: "bun-darwin-x64", binaryName: "testflow" },
  "darwin-arm64": { target: "bun-darwin-arm64", binaryName: "testflow" },
  "win32-x64": { target: "bun-windows-x64", binaryName: "testflow.exe" },
}

const config = targetMap[targetPlatform]
if (!config) {
  throw new Error(
    `Unsupported target platform: ${targetPlatform}. Supported: ${Object.keys(targetMap).join(", ")}`
  )
}

const target = config.target
const binaryName = config.binaryName
const testflowBin = join(binDir, binaryName)
const testflowResDir = join(binDir, "testflow-res")

log(`Building for target: ${targetPlatform} (${target})`)

// 1. build testflow dist (tsc)
log("Building testflow dist...")
await $`bun run build`.cwd(testflowDir)

// 2. compile standalone binary
log(`Compiling testflow binary (${target})...`)
await $`bun build src/cli-entry.ts --compile --target=${target} --outfile ${testflowBin}`.cwd(testflowDir)

// 3. copy resource files (templates + config) next to the binary
log("Copying testflow resources...")
if (existsSync(testflowResDir)) rmSync(testflowResDir, { recursive: true })
mkdirSync(testflowResDir, { recursive: true })
cpSync(join(testflowDir, "dist", "config"), join(testflowResDir, "config"), { recursive: true })
cpSync(join(testflowDir, "dist", "templates"), join(testflowResDir, "templates"), { recursive: true })

log(`✅ Done. Binary: ${testflowBin}`)
