import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

export function registerHeapSnapshot(context: vscode.ExtensionContext, connectionService: KiloConnectionService): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("testagent.new.takeHeapSnapshot", async () => {
      try {
        const file = await snapshot(connectionService)
        vscode.window.showInformationMessage(`堆快照已写入 ${file}`)
      } catch (err) {
        vscode.window.showErrorMessage(`写入堆快照失败: ${message(err)}`)
      }
    }),
  )
}

async function snapshot(connectionService: KiloConnectionService) {
  await connectionService.getClientAsync()
  const cfg = connectionService.getServerConfig()
  if (!cfg) throw new Error("CLI server is not connected")

  const auth = Buffer.from(`kilo:${cfg.password}`).toString("base64")
  const res = await fetch(`${cfg.baseUrl}/kilocode/heap/snapshot`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
    },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as string
}

function message(err: unknown) {
  if (err instanceof Error) return err.message
  return String(err)
}
