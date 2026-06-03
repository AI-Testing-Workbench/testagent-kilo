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

const testflowBin = join(binDir, process.platform === "win32" ? "testflow.exe" : "testflow")
const testflowResDir = join(binDir, "testflow-res")

// 1. build testflow dist (tsc)
log("Building testflow dist...")
await $`bun run build`.cwd(testflowDir)

// 2. compile standalone binary
log("Compiling testflow binary...")
await $`bun build src/cli-entry.ts --compile --outfile ${testflowBin}`.cwd(testflowDir)

// 3. copy resource files (templates + config) next to the binary
log("Copying testflow resources...")
if (existsSync(testflowResDir)) rmSync(testflowResDir, { recursive: true })
mkdirSync(join(testflowResDir, "config"), { recursive: true })
mkdirSync(join(testflowResDir, "templates"), { recursive: true })
cpSync(join(testflowDir, "dist", "config", "index.yaml"), join(testflowResDir, "config", "index.yaml"))
cpSync(join(testflowDir, "dist", "templates"), join(testflowResDir,"templates"), { recursive: true })

log(`Done. Binary: ${testflowBin}`)
