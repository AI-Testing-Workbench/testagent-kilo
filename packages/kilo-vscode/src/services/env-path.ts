import * as vscode from "vscode"
import { exec } from "child_process"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

const ENV_PATH_ADDED_KEY = "testagent.envPathAdded"

/**
 * Add the CLI binary directory to Windows PATH environment variable.
 * Only runs once per extension installation (tracked in globalState).
 */
export async function ensureCliInPath(context: vscode.ExtensionContext): Promise<void> {
  // Only run on Windows
  if (process.platform !== "win32") return

  // Check if already added
  const alreadyAdded = context.globalState.get<boolean>(ENV_PATH_ADDED_KEY)
  if (alreadyAdded) return

  const binDir = path.join(context.extensionPath, "bin")

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
    const script = `
$binDir = '${escapedBinDir}'
$currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
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

        const result = stdout.trim()
        if (result === "added") {
          console.log("[TestAgent] Added CLI to user PATH:", binDir)
          vscode.window.showInformationMessage(
            "TestAgent CLI has been added to your PATH. Restart your terminal to use 'testagent' command.",
          )
        } else if (result === "exists") {
          console.log("[TestAgent] CLI already in PATH:", binDir)
        }

        // Mark as added so we don't run this again
        context.globalState.update(ENV_PATH_ADDED_KEY, true)
        resolve()
      })
    })
  } catch (err) {
    console.error("[TestAgent] Failed to add CLI to PATH:", err)
  }
}
