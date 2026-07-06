/**
 * System notification service using native OS notifications.
 * Shows notifications in Windows notification center, macOS notification center, or Linux desktop.
 *
 * testagent_change - System notification implementation
 */

import * as notifier from "node-notifier"
import * as path from "path"
import * as vscode from "vscode"

export type NotificationType = "info" | "warning" | "error"

export interface SystemNotificationOptions {
  title: string
  message: string
  type?: NotificationType
  onClick?: () => void
}

export class SystemNotificationService {
  constructor(private extensionUri: vscode.Uri) {}

  /**
   * Show a system notification that appears in the OS notification center.
   * Works on Windows, macOS, and Linux.
   */
  notify(options: SystemNotificationOptions): void {
    const { title, message, type = "info", onClick } = options

    const iconPath = this.getIconPath(type)

    if (process.platform === "darwin") {
      this.showMacOSNotification(title, message, onClick)
      return
    }

    if (process.platform === "win32") {
      this.showWindowsNotification(title, message, onClick)
      return
    }

    try {
      notifier.notify(
        {
          title,
          message,
          icon: iconPath,
          wait: false,
          timeout: 10,
        } as any,
        (err, response) => {
          if (err) {
            this.showVSCodeFallback(title, message, type, onClick)
            return
          }

          if (response === "activate" && onClick) {
            onClick()
          }
        },
      )
    } catch (error) {
      this.showVSCodeFallback(title, message, type, onClick)
    }
  }

  /**
   * Show notification on macOS using osascript (AppleScript).
   */
  private showMacOSNotification(title: string, message: string, onClick?: () => void): void {
    const { exec } = require("child_process")

    const escapedTitle = title.replace(/"/g, '\\"')
    const escapedMessage = message.replace(/"/g, '\\"')

    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name "default"`

    exec(`osascript -e '${script}'`, (error: any) => {
      if (error) {
        this.showVSCodeFallback(title, message, "info", onClick)
        return
      }
    })
  }

  /**
   * Show notification on Windows using non-blocking PowerShell Toast (fire-and-forget).
   * Spawns the process with stdio: "ignore" so it doesn't block the extension host event loop.
   */
  private showWindowsNotification(title: string, message: string, onClick?: () => void): void {
    this.ensureWindowsAppIDRegistered()
    this.showPowerShellToast(title, message, onClick)
  }

  /**
   * Show Windows Toast notification using PowerShell with COM objects — non-blocking.
   * Uses spawn() with stdio: "ignore" and async file I/O to avoid blocking
   * the extension host event loop (which was causing health check timeouts).
   */
  private async showPowerShellToast(title: string, message: string, onClick?: () => void): Promise<void> {
    const { spawn } = require("child_process") as { spawn: typeof import("child_process").spawn }
    const fs = require("fs") as typeof import("fs")
    const os = require("os") as typeof import("os")

    const appID = "TestAgent"

    // Escape XML special characters
    const xmlEscape = (str: string) =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")

    const escapedMessage = xmlEscape(message)

    const toastXml = `<toast><visual><binding template="ToastText02"><text id="2">${escapedMessage}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default" /></toast>`

    console.log("[TestAgent] 📝 Toast XML:", toastXml)

    const tempDir = os.tmpdir()
    const scriptPath = path.join(tempDir, `testagent-toast-${Date.now()}.ps1`)

    const psScript = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$toastXml = @"
${toastXml}
"@

try {
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($toastXml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appID}')
    $notifier.Show($toast)
} catch {
    exit 1
}
`.trim()

    try {
      await fs.promises.writeFile(scriptPath, "\ufeff" + psScript, "utf8")

      // Spawn with stdio: "ignore" — completely detached from the event loop.
      // No callbacks, no stdout/stderr buffering, no blocking.
      const child = spawn("powershell", [
        "-Sta", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", scriptPath,
      ], {
        stdio: "ignore",
        timeout: 10000,
      })

      child.on("close", () => {
        fs.promises.unlink(scriptPath).catch(() => {})
      })

      child.on("error", (err: Error) => {
        console.warn("[TestAgent] ⚠️ PowerShell spawn failed:", err.message)
      })
    } catch (err) {
      console.warn("[TestAgent] ⚠️ Failed to create PowerShell toast:", err)
    }
  }

  /**
   * Ensure Windows AppID is registered in registry for Toast notifications — non-blocking.
   * Required for Windows 10 Fall Creators Update and above.
   * Fire-and-forget: runs once, never blocks the event loop.
   */
  private ensureWindowsAppIDRegistered(): void {
    if ((this as any)._appIDRegistered) return

    const { spawn } = require("child_process") as { spawn: typeof import("child_process").spawn }
    const appID = "TestAgent"
    const iconPath = path.join(this.extensionUri.fsPath, "resources", "icon.png").replace(/\\/g, "\\\\")
    ;(this as any)._appIDRegistered = true
    const psScript = `
$AppID = '${appID}';
$RegPath = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$AppID";
try {
  if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null;
  }
  Set-ItemProperty -Path $RegPath -Name 'DisplayName' -Value 'TestAgent' -Type String;
  if (Test-Path '${iconPath}') {
    Set-ItemProperty -Path $RegPath -Name 'IconUri' -Value '${iconPath}' -Type String;
  }
} catch {}
`.trim()

    // Spawn with stdio: "ignore" — fire and forget, never blocks.
    spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-Command", psScript,
    ], {
      stdio: "ignore",
      timeout: 5000,
    })
  }

  /**
   * Get icon path based on notification type.
   */
  private getIconPath(type: NotificationType): string {
    const iconName = type === "error" ? "error.png" : type === "warning" ? "warning.png" : "icon.png"
    const customIconPath = path.join(this.extensionUri.fsPath, "resources", iconName)

    const fs = require("fs")
    if (fs.existsSync(customIconPath)) {
      return customIconPath
    }

    const fallbackPath = path.join(this.extensionUri.fsPath, "resources", "icon.png")
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath
    }
    return undefined as any
  }

  /**
   * Fallback to VS Code notification if system notification fails.
   */
  private showVSCodeFallback(
    title: string,
    message: string,
    type: NotificationType,
    onClick?: () => void,
  ): void {
    const fullMessage = `${title}: ${message}`
    const action = "显示"

    const showPromise =
      type === "error"
        ? vscode.window.showErrorMessage(fullMessage, action)
        : type === "warning"
          ? vscode.window.showWarningMessage(fullMessage, action)
          : vscode.window.showInformationMessage(fullMessage, action)

    showPromise.then((selected) => {
      if (selected === action && onClick) {
        onClick()
      }
    })
  }
}
