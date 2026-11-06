#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"

/**
 * Ensures the VS Code extension has a CLI binary at `packages/kilo-vscode/bin/testagent`.
 *
 * Always builds from packages/testagent-core:
 *   - bun bun:mac      (macOS / linux)
 *   - bun bun:windows  (windows)
 * Those scripts build the binary AND copy it into packages/kilo-vscode/bin/ automatically.
 */
// testagent_change start - use testagent-core instead of opencode
const kiloVscodeDir = join(import.meta.dir, "..")
const testagentDir = join(kiloVscodeDir, "..", "testagent-core")
const script =
  process.platform === "win32" ? (process.arch === "arm64" ? "bun:windows-arm64" : "bun:windows") : "bun:mac"

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
  log(`Building CLI binary via '${script}' in packages/testagent-core...`)
  await $`bun run ${script}`.cwd(testagentDir)
  log(`Build complete. Binary copied to ${binDir}`)
  bundlePsBash(binDir)
}

/**
 * Copy the ps-bash Windows archive into the extension so the bash tool can use a
 * POSIX-compatible shell on Windows. The file is fetched once and cached under
 * bin/ps-bash/; see src/services/cli-backend/ps-bash-installer.ts for extraction.
 */
function bundlePsBash(binDir: string) {
  const name = "ps-bash-v0.14.0-win-x64.zip"
  const source = join(kiloVscodeDir, "resources", "ps-bash", name)
  if (!existsSync(source)) {
    log(`ps-bash archive not found at ${source}; skipping Windows POSIX shell bundle`)
    return
  }
  const targetDir = join(binDir, "ps-bash")
  mkdirSync(targetDir, { recursive: true })
  copyFileSync(source, join(targetDir, name))
  log(`Bundled ps-bash archive into ${targetDir}`)
}

try {
  await main()
} catch (err) {
  console.error(`[local-bin] ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
