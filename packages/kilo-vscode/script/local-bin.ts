#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"

/**
 * Ensures the VS Code extension has a CLI binary at `packages/kilo-vscode/bin/testagent`.
 *
 * Always builds from packages/testagent-opencode:
 *   - bun bun:mac      (macOS / linux)
 *   - bun bun:windows  (windows)
 * Those scripts build the binary AND copy it into packages/kilo-vscode/bin/ automatically.
 */
// testagent_change start - use testagent-opencode instead of opencode
const kiloVscodeDir = join(import.meta.dir, "..")
const testagentDir = join(kiloVscodeDir, "..", "testagent-opencode")
const script = process.platform === "win32" ? "bun:windows" : "bun:mac"

function log(msg: string) {
  console.log(`[local-bin] ${msg}`)
}

async function main() {
  const binDir = join(kiloVscodeDir, "bin")
  try {
    await Bun.file(binDir).stat()
  } catch {
    log(`Creating bin directory at ${binDir}`)
    await Bun.write(join(binDir, ".gitkeep"), "")
  }
  log(`Building CLI binary via '${script}' in packages/testagent-opencode...`)
  await $`bun run ${script}`.cwd(testagentDir)
  log(`Build complete. Binary copied to ${binDir}`)
}

try {
  await main()
} catch (err) {
  console.error(`[local-bin] ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
