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

    console.log("[TestAgent] 🔔 Attempting to show system notification:", { title, message, type })

    // Get icon path based on notification type
    const iconPath = this.getIconPath(type)
    console.log("[TestAgent] 📁 Icon path:", iconPath)

    // Check platform and use appropriate method
    if (process.platform === "darwin") {
      // macOS: Use osascript
      this.showMacOSNotification(title, message, onClick)
      return
    }

    if (process.platform === "win32") {
      // Windows: Use node-notifier with AppID registration
      this.showWindowsNotification(title, message, onClick)
      return
    }

    // Linux or fallback: Try node-notifier
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
            console.error("[TestAgent] ❌ System notification error:", err)
            this.showVSCodeFallback(title, message, type, onClick)
            return
          }

          console.log("[TestAgent] ✅ System notification shown successfully, response:", response)

          if (response === "activate" && onClick) {
            console.log("[TestAgent] 👆 User clicked notification, calling onClick")
            onClick()
          }
        },
      )

      console.log("[TestAgent] 📤 notifier.notify() called, waiting for callback...")
    } catch (error) {
      console.error("[TestAgent] ❌ Exception while showing notification:", error)
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
        console.error("[TestAgent] ❌ macOS notification error:", error)
        this.showVSCodeFallback(title, message, "info", onClick)
        return
      }
      console.log("[TestAgent] ✅ macOS notification shown successfully")
    })
  }

  /**
   * Show notification on Windows using PowerShell Toast.
   * This is more reliable than node-notifier in VS Code extension context.
   */
  private showWindowsNotification(title: string, message: string, onClick?: () => void): void {
    console.log("[TestAgent] 🪟 Starting Windows notification with PowerShell Toast")
    console.log("[TestAgent] 📝 Title:", title)
    console.log("[TestAgent] 📝 Message:", message)

    // Ensure AppID is registered first
    this.ensureWindowsAppIDRegistered()
      .then(() => {
        console.log("[TestAgent] ✅ AppID registered, showing Toast notification...")
        return this.showPowerShellToast(title, message, onClick)
      })
      .catch((err) => {
        console.error("[TestAgent] ❌ Toast notification failed:", err.message)
        console.log("[TestAgent] 🔄 Falling back to VS Code notification")
        this.showVSCodeFallback(title, message, "info", onClick)
      })
  }

  /**
   * Show Windows Toast notification using PowerShell with COM objects.
   * This method uses COM interface which may have better permissions than subprocess.
   */
  private async showPowerShellToast(title: string, message: string, onClick?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const { exec } = require("child_process")
      const fs = require("fs")
      const os = require("os")

      const appID = "TestAgent"

      // Escape XML special characters
      const xmlEscape = (str: string) =>
        str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&apos;")

      const escapedTitle = xmlEscape(title)
      const escapedMessage = xmlEscape(message)

      // Create Toast XML - simple version without image first
      const toastXml = `<toast><visual><binding template="ToastText02"><text id="2">${escapedMessage}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default" /></toast>`

      console.log("[TestAgent] 📦 Creating PowerShell script with COM objects...")
      console.log("[TestAgent] 📝 Toast XML:", toastXml)

      // Create a temporary PowerShell script file
      const tempDir = os.tmpdir()
      const scriptPath = path.join(tempDir, `testagent-toast-${Date.now()}.ps1`)

      // PowerShell script using COM with better error handling
      const psScript = `
# Load Windows Runtime assemblies
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

# Toast XML
$toastXml = @"
${toastXml}
"@

try {
    Write-Host "Creating XML document..."
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($toastXml)
    Write-Host "XML loaded successfully"
    
    Write-Host "Creating toast notification..."
    $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
    Write-Host "Toast created successfully"
    
    Write-Host "Creating notifier with AppID: ${appID}"
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appID}')
    Write-Host "Notifier created successfully"
    
    Write-Host "Showing toast..."
    $notifier.Show($toast)
    Write-Host "SUCCESS: Toast notification displayed"
    exit 0
} catch {
    Write-Error "FAILED: $($_.Exception.Message)"
    Write-Error "Type: $($_.Exception.GetType().FullName)"
    Write-Error "Stack: $($_.ScriptStackTrace)"
    exit 1
}
`.trim()

      try {
        // Write script to temp file with UTF-8 BOM encoding
        fs.writeFileSync(scriptPath, "\ufeff" + psScript, "utf8")
        console.log("[TestAgent] ✅ PowerShell script created at:", scriptPath)

        // Execute PowerShell script with COM support
        const command = `powershell -Sta -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`

        console.log("[TestAgent] 🚀 Executing PowerShell with COM objects...")

        exec(command, { encoding: "utf8", timeout: 10000 }, (error: any, stdout: any, stderr: any) => {
          // Clean up temp file
          try {
            fs.unlinkSync(scriptPath)
            console.log("[TestAgent] 🗑️ Temp script deleted")
          } catch (cleanupError) {
            console.warn("[TestAgent] ⚠️ Failed to delete temp script:", cleanupError)
          }

          console.log("[TestAgent] 📊 PowerShell execution completed")
          console.log("[TestAgent] 📤 stdout:", stdout || "(empty)")
          console.log("[TestAgent] 📤 stderr:", stderr || "(empty)")
          console.log("[TestAgent] ❓ error:", error ? error.message : "(none)")

          if (error) {
            console.error("[TestAgent] ❌ PowerShell COM Toast error:", error.message)
            reject(error)
            return
          }

          console.log("[TestAgent] ✅ PowerShell COM Toast executed successfully")
          resolve()
        })
      } catch (fileError) {
        console.error("[TestAgent] ❌ Failed to create temp script:", fileError)
        reject(fileError)
      }
    })
  }

  /**
   * Ensure Windows AppID is registered in registry for Toast notifications.
   * Required for Windows 10 Fall Creators Update and above.
   */
  private async ensureWindowsAppIDRegistered(): Promise<void> {
    // Check if already registered (cache the result)
    if ((this as any)._appIDRegistered) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const { exec } = require("child_process")
      const appID = "TestAgent"
      const displayName = "TestAgent"
      const iconPath = path.join(this.extensionUri.fsPath, "resources", "icon.png").replace(/\\/g, "\\\\")

      console.log("[TestAgent] 📝 Registering Windows AppID:", appID)
      console.log("[TestAgent] 📁 Icon path:", iconPath)

      const psScript = `
$AppID = '${appID}';
$RegPath = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$AppID";
try {
  if (-not (Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null;
  }
  Set-ItemProperty -Path $RegPath -Name 'DisplayName' -Value '${displayName}' -Type String;
  if (Test-Path '${iconPath}') {
    Set-ItemProperty -Path $RegPath -Name 'IconUri' -Value '${iconPath}' -Type String;
  }
  Write-Host 'SUCCESS';
  exit 0;
} catch {
  Write-Error $_;
  exit 1;
}
`.trim()

      const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`

      exec(command, { encoding: "utf8", timeout: 5000 }, (error: any, stdout: any, stderr: any) => {
        if (error) {
          console.warn("[TestAgent] ⚠️ Failed to register AppID:", error.message)
          if (stdout) console.log("[TestAgent] stdout:", stdout)
          if (stderr) console.log("[TestAgent] stderr:", stderr)
          reject(error)
          return
        }

        console.log("[TestAgent] ✅ Windows AppID registered successfully")
        if (stdout) console.log("[TestAgent] stdout:", stdout)
        ;(this as any)._appIDRegistered = true
        resolve()
      })
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
      console.log("[TestAgent] ✅ Using custom icon:", customIconPath)
      return customIconPath
    }

    const fallbackPath = path.join(this.extensionUri.fsPath, "resources", "icon.png")
    if (fs.existsSync(fallbackPath)) {
      console.log("[TestAgent] ✅ Using fallback icon:", fallbackPath)
      return fallbackPath
    }

    console.log("[TestAgent] ⚠️ No icon found, using undefined")
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
