import * as vscode from "vscode"
import { exec } from "child_process"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

const ENV_PATH_ADDED_KEY = "testagent.envPathAdded"
const ENV_PATH_LAST_BIN_DIR_KEY = "testagent.lastBinDir"

/**
 * Add the CLI binary directory to Windows PATH environment variable.
 * Runs on every activation to handle:
 * 1. User manually removing the path from environment variables
 * 2. Extension upgrades that change the extension path
 * 3. Cleanup of old extension paths from previous versions
 */
export async function ensureCliInPath(context: vscode.ExtensionContext): Promise<void> {
  // Only run on Windows
  if (process.platform !== "win32") return

  const binDir = path.join(context.extensionPath, "bin")
  const lastBinDir = context.globalState.get<string>(ENV_PATH_LAST_BIN_DIR_KEY)

  // Check if path has changed (extension upgraded or reinstalled)
  const pathChanged = lastBinDir && lastBinDir !== binDir

  // Check if already added and path hasn't changed
  const alreadyAdded = context.globalState.get<boolean>(ENV_PATH_ADDED_KEY)
  if (alreadyAdded && !pathChanged) {
    // Verify it's still in PATH
    const stillInPath = await checkIfInPath(binDir)
    if (stillInPath) return
    console.log("[TestAgent] CLI was removed from PATH, re-adding...")
  }

  // Verify bin directory exists
  if (!fs.existsSync(binDir)) {
    console.warn("[TestAgent] bin directory not found:", binDir)
    return
  }

  try {
    // Create a temporary PowerShell script file
    const tempFile = path.join(os.tmpdir(), `testagent-path-${Date.now()}.ps1`)
    // Escape backslashes and single quotes for PowerShell
    const escapedBinDir = binDir.replace(/\\/g, "\\\\").replace(/'/g, "''")
    const escapedOldBinDir = lastBinDir ? lastBinDir.replace(/\\/g, "\\\\").replace(/'/g, "''") : ""
    
    const script = `
$binDir = '${escapedBinDir}'
$oldBinDir = '${escapedOldBinDir}'
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")

# Remove old extension path if it exists and is different
if ($oldBinDir -and $oldBinDir -ne $binDir -and $currentPath -like "*$oldBinDir*") {
  $pathArray = $currentPath -split ';' | Where-Object { $_ -and $_ -ne $oldBinDir }
  $currentPath = $pathArray -join ';'
  Write-Output "removed_old"
}

# Add new path if not already present
if ($currentPath -notlike "*$binDir*") {
  $newPath = $currentPath + ";" + $binDir
  [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
  Write-Output "added"
} else {
  Write-Output "exists"
}
`.trim()

    fs.writeFileSync(tempFile, script, "utf8")

    await new Promise<void>((resolve, reject) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, (err, stdout, stderr) => {
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile)
        } catch {}

        if (err) {
          console.error("[TestAgent] PowerShell error:", stderr)
          reject(err)
          return
        }

        const results = stdout.trim().split("\n").map((s) => s.trim())
        const removedOld = results.includes("removed_old")
        const added = results.includes("added")
        const exists = results.includes("exists")

        if (removedOld && lastBinDir) {
          console.log("[TestAgent] Removed old CLI path from PATH:", lastBinDir)
        }

        if (added) {
          console.log("[TestAgent] Added CLI to user PATH:", binDir)
          const message = pathChanged
            ? "TestAgent CLI has been updated in your PATH. Restart your terminal to use the new version."
            : "TestAgent CLI has been added to your PATH. Restart your terminal to use 'testagent' command."
          vscode.window.showInformationMessage(message)
        } else if (exists) {
          console.log("[TestAgent] CLI already in PATH:", binDir)
        }

        // Update state with current bin directory
        context.globalState.update(ENV_PATH_ADDED_KEY, true)
        context.globalState.update(ENV_PATH_LAST_BIN_DIR_KEY, binDir)
        resolve()
      })
    })
  } catch (err) {
    console.error("[TestAgent] Failed to add CLI to PATH:", err)
  }
}

/**
 * Check if the given directory is currently in the user's PATH environment variable.
 */
async function checkIfInPath(binDir: string): Promise<boolean> {
  try {
    const tempFile = path.join(os.tmpdir(), `testagent-check-path-${Date.now()}.ps1`)
    const escapedBinDir = binDir.replace(/\\/g, "\\\\").replace(/'/g, "''")
    const script = `
$binDir = '${escapedBinDir}'
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -like "*$binDir*") {
  Write-Output "true"
} else {
  Write-Output "false"
}
`.trim()

    fs.writeFileSync(tempFile, script, "utf8")

    return new Promise<boolean>((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, (err, stdout) => {
        try {
          fs.unlinkSync(tempFile)
        } catch {}

        if (err) {
          resolve(false)
          return
        }

        resolve(stdout.trim() === "true")
      })
    })
  } catch {
    return false
  }
}
