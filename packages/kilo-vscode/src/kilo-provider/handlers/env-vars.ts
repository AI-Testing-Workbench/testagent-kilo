// testagent_change - new file
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type * as vscode from "vscode"
import { getErrorMessage } from "../../kilo-provider-utils"

const formatEnvVarsLoadError = (error: unknown) =>
  getErrorMessage(error).replace(/^Error:\s*/, "").split(/\n\s*at\s+/)[0].trim()

/**
 * Fetch environment variables from backend and send to webview
 */
export async function handleRequestEnvVars(
  client: KiloClient,
  webview: vscode.Webview | null,
): Promise<void> {
  if (!webview) return

  try {
    const response = await client.testagent.envVars.list(undefined, { throwOnError: true })
    const envVars = response.data || { system: {}, custom: {} }
    webview.postMessage({ type: "envVarsData", envVars })
  } catch (error) {
    console.error("[TestAgent] Failed to fetch env vars:", error)
    webview.postMessage({
      type: "envVarsData",
      envVars: { system: {}, custom: {} },
      error: formatEnvVarsLoadError(error),
    })
  }
}

/**
 * Create a new environment variable (batch operation with single item)
 */
export async function handleCreateEnvVar(
  client: KiloClient,
  webview: vscode.Webview | null,
  key: string,
  value: string,
): Promise<void> {
  try {
    const response = await client.testagent.customEnvVars.batchCreate({ body: [{ key, value }] })
    const result = response.data
    
    if (!result) {
      webview?.postMessage({
        type: "envVarSetError",
        key,
        error: "创建失败：服务响应为空",
      })
      return
    }
    
    if (result.failedKeys.includes(key)) {
      webview?.postMessage({
        type: "envVarSetError",
        key,
        error: "创建失败：Key 已存在或格式非法",
      })
      return
    }
    
    // Refresh the list after successful create
    await handleRequestEnvVars(client, webview)
  } catch (error) {
    console.error("[TestAgent] Failed to create env var:", error)
    webview?.postMessage({
      type: "envVarSetError",
      key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Update an existing environment variable (batch operation with single item)
 */
export async function handleUpdateEnvVar(
  client: KiloClient,
  webview: vscode.Webview | null,
  key: string,
  value: string,
): Promise<void> {
  try {
    const response = await client.testagent.customEnvVars.batchUpdate({ body: [{ key, value }] })
    const result = response.data
    
    if (!result) {
      webview?.postMessage({
        type: "envVarSetError",
        key,
        error: "更新失败：服务响应为空",
      })
      return
    }
    
    if (result.failedKeys.includes(key)) {
      webview?.postMessage({
        type: "envVarSetError",
        key,
        error: "更新失败：Key 不存在或格式非法",
      })
      return
    }
    
    // Refresh the list after successful update
    await handleRequestEnvVars(client, webview)
  } catch (error) {
    console.error("[TestAgent] Failed to update env var:", error)
    webview?.postMessage({
      type: "envVarSetError",
      key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Delete an environment variable (batch operation with single key)
 */
export async function handleDeleteEnvVar(
  client: KiloClient,
  webview: vscode.Webview | null,
  key: string,
): Promise<void> {
  try {
    await client.testagent.customEnvVars.batchDelete({ body: [key] })
    // Refresh the list after successful delete
    await handleRequestEnvVars(client, webview)
  } catch (error) {
    console.error("[TestAgent] Failed to delete env var:", error)
    webview?.postMessage({
      type: "envVarDeleteError",
      key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
