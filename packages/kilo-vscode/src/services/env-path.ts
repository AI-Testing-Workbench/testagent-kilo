import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { exec } from "../util/process"

const ENV_PATH_ADDED_KEY = "testagent.envPathAdded"
const ENV_PATH_LAST_BIN_DIR_KEY = "testagent.lastBinDir"
const TESTAGENT_ENV_VAR = "TestAgent"
const TESTAGENT_PATH_REF_WIN = "%TestAgent%"
const TESTAGENT_PATH_REF_UNIX = "$TestAgent"

/**
 * Add the CLI binary directory to system PATH environment variable.
 *
 * Cross-platform approach:
 *
 * Windows:
 * 1. Sets the TestAgent environment variable to the bin directory path
 * 2. Adds %TestAgent% reference to PATH (only once)
 *
 * macOS/Linux:
 * 1. Exports TestAgent variable in shell config files
 * 2. Adds $TestAgent to PATH (only once)
 * 3. Detects and updates all common shell configs (.bashrc, .zshrc, .profile, etc.)
 *
 * This approach is cleaner because:
 * - Extension upgrades only update the TestAgent variable, not PATH
 * - PATH remains clean with just the variable reference
 * - Easier to manage and debug
 */
export async function ensureCliInPath(context: vscode.ExtensionContext): Promise<void> {
  const binDir = path.join(context.extensionPath, "bin")
  const lastBinDir = context.globalState.get<string>(ENV_PATH_LAST_BIN_DIR_KEY)

  if (!fs.existsSync(binDir)) {
    console.warn("[TestAgent] bin directory not found:", binDir)
    return
  }

  try {
    if (process.platform === "win32") {
      await ensureCliInPathWindows(context, binDir)
    } else {
      await ensureCliInPathUnix(context, binDir, lastBinDir)
    }
  } catch (err) {
    console.error("[TestAgent] Failed to configure CLI environment:", err)
  }
}

/**
 * Windows-specific PATH configuration using environment variables.
 * Sets TestAgent env var to the bin directory and adds %TestAgent% to PATH.
 */
async function ensureCliInPathWindows(
  context: vscode.ExtensionContext,
  binDir: string
): Promise<void> {
  const tempFile = path.join(os.tmpdir(), `testagent-path-${Date.now()}.ps1`)
  const escapedBinDir = binDir.replace(/'/g, "''")

  const script = `
$binDir = '${escapedBinDir}'
$envVarName = '${TESTAGENT_ENV_VAR}'
$pathRef = '${TESTAGENT_PATH_REF_WIN}'

# Set TestAgent environment variable to the bin directory
[Environment]::SetEnvironmentVariable($envVarName, $binDir, "User")

# Add %TestAgent% reference to PATH if not already present
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")

# Remove any paths containing "testagent" before adding the reference
# but keep the %TestAgent% reference itself
$pathArray = $currentPath -split ';' | Where-Object { $_ }
$cleanedPathArray = $pathArray | Where-Object { $_ -notlike "*testagent*" -or $_ -like "*$pathRef*" }
if ($pathArray.Count -ne $cleanedPathArray.Count) {
  $currentPath = $cleanedPathArray -join ';'
  Write-Output "removed_testagent_paths"
}

if ($currentPath -notlike "*$pathRef*") {
  $newPath = $currentPath + ";" + $pathRef
  [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
  Write-Output "added_ref"
} else {
  Write-Output "ref_exists"
}
`.trim()

  fs.writeFileSync(tempFile, script, "utf8")

  try {
    const { stdout } = await exec("powershell", [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      tempFile,
    ])

    const results = stdout.trim().split("\n").map((s) => s.trim())
    const addedRef = results.includes("added_ref")
    const refExists = results.includes("ref_exists")

    if (addedRef) {
      console.log(`[TestAgent] Added ${TESTAGENT_PATH_REF_WIN} to user PATH`)
      // const message = "TestAgent CLI 已添加到你的 PATH 中，重启终端后可使用 'testagent' 命令。"
      // vscode.window.showInformationMessage(message)
    } else if (refExists) {
      console.log(`[TestAgent] ${TESTAGENT_PATH_REF_WIN} already in PATH, ${TESTAGENT_ENV_VAR}=${binDir}`)
    }
  } catch (err) {
    console.error("[TestAgent] Failed to configure Windows CLI environment:", err)
    throw err
  } finally {
    try {
      fs.unlinkSync(tempFile)
    } catch {}
  }

  context.globalState.update(ENV_PATH_ADDED_KEY, true)
  context.globalState.update(ENV_PATH_LAST_BIN_DIR_KEY, binDir)
}

/**
 * macOS/Linux-specific PATH configuration using shell config files
 */
async function ensureCliInPathUnix(
  context: vscode.ExtensionContext,
  binDir: string,
  lastBinDir: string | undefined
): Promise<void> {
  const homeDir = os.homedir()

  const configFiles = [
    path.join(homeDir, ".bashrc"),
    path.join(homeDir, ".bash_profile"),
    path.join(homeDir, ".zshrc"),
    path.join(homeDir, ".profile"),
  ]

  const existingConfigs = configFiles.filter((file) => fs.existsSync(file))

  if (existingConfigs.length === 0) {
    existingConfigs.push(path.join(homeDir, ".profile"))
  }

  const marker = "# TestAgent CLI Environment Variable"
  const exportLine = `export ${TESTAGENT_ENV_VAR}="${binDir}"`
  const pathLine = `export PATH="${TESTAGENT_PATH_REF_UNIX}:$PATH"`

  let anyUpdated = false
  let anyAdded = false

  for (const configFile of existingConfigs) {
    let fileAnyAdded = false
    let fileAnyUpdated = false

    try {
      let content = ""
      let fileExists = fs.existsSync(configFile)

      if (fileExists) {
        content = fs.readFileSync(configFile, "utf8")
      }

      const hasMarker = content.includes(marker)
      const hasExport = content.includes(`export ${TESTAGENT_ENV_VAR}=`)
      const hasPathRef = content.includes(TESTAGENT_PATH_REF_UNIX)

      if (lastBinDir && content.includes(lastBinDir)) {
        const lines = content.split("\n")
        const filtered = lines.filter((line) => !line.includes(lastBinDir) || line.includes(marker))
        content = filtered.join("\n")
        fileAnyUpdated = true
        anyUpdated = true
      }

      if (hasMarker) {
        const lines = content.split("\n")
        let inTestAgentSection = false
        const updated = []

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]

          if (line.includes(marker)) {
            inTestAgentSection = true
            updated.push(line)
            continue
          }

          if (inTestAgentSection) {
            if (line.startsWith("export " + TESTAGENT_ENV_VAR)) {
              updated.push(exportLine)
              fileAnyUpdated = true
              anyUpdated = true
              continue
            } else if (line.includes(TESTAGENT_PATH_REF_UNIX)) {
              updated.push(line)
              inTestAgentSection = false
              continue
            } else if (line.trim() === "") {
              inTestAgentSection = false
            }
          }

          updated.push(line)
        }

        content = updated.join("\n")
      } else if (hasExport || hasPathRef) {
        const lines = content.split("\n")
        const updated = []
        let addedSection = false

        for (const line of lines) {
          if (
            (line.includes(`export ${TESTAGENT_ENV_VAR}=`) || line.includes(TESTAGENT_PATH_REF_UNIX)) &&
            !addedSection
          ) {
            updated.push("")
            updated.push(marker)
            updated.push(exportLine)
            updated.push(pathLine)
            addedSection = true
            fileAnyAdded = true
            anyAdded = true
            anyUpdated = true
            continue
          }

          if (line.includes(`export ${TESTAGENT_ENV_VAR}=`) || line.includes(TESTAGENT_PATH_REF_UNIX)) {
            continue
          }

          updated.push(line)
        }

        content = updated.join("\n")
      } else {
        if (!content.endsWith("\n") && content.length > 0) {
          content += "\n"
        }
        content += `\n${marker}\n${exportLine}\n${pathLine}\n`
        fileAnyAdded = true
        anyAdded = true
      }

      fs.writeFileSync(configFile, content, "utf8")

      if (fileAnyAdded) {
        console.log(`[TestAgent] Added CLI configuration to ${path.basename(configFile)}`)
      } else if (fileAnyUpdated) {
        console.log(`[TestAgent] Updated CLI configuration in ${path.basename(configFile)}`)
      }
    } catch (err) {
      console.error(`[TestAgent] Failed to update ${configFile}:`, err)
    }
  }

  context.globalState.update(ENV_PATH_ADDED_KEY, true)
  context.globalState.update(ENV_PATH_LAST_BIN_DIR_KEY, binDir)

  if (anyAdded) {
    const shellFiles = existingConfigs.map((f) => path.basename(f)).join(", ")
    const message = `TestAgent CLI 已添加到你的 shell 配置 (${shellFiles})，重启终端后可使用 'testagent' 命令。`
    vscode.window.showInformationMessage(message)
  } else if (anyUpdated) {
    const message = "TestAgent CLI 路径已更新，重启终端后生效。"
    vscode.window.showInformationMessage(message)
  } else {
    console.log(`[TestAgent] CLI already configured: ${TESTAGENT_ENV_VAR}=${binDir}`)
  }
}