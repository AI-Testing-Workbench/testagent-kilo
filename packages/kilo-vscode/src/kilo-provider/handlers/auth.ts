/**
 * Authentication handlers — extracted from KiloProvider.
 *
 * Manages login (device auth flow), logout, organization switching,
 * and profile refresh. No vscode dependency.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../../kilo-provider-utils"
import { handleClearRemoteEnvVars, handleEnsureRemoteEnvVars } from "./env-vars"

export interface AuthContext {
  readonly client: KiloClient | null
  postMessage(msg: unknown): void
  getWorkspaceDirectory(): string
  disposeGlobal(): Promise<void>
  fetchAndSendProviders(): Promise<void>
  fetchAndSendAgents(): Promise<void>
}

/**
 * Handle login via the provider OAuth device-auth flow.
 * Sends device auth messages so the webview can display QR code, code, and timer.
 *
 * @param attempt - The current login attempt counter value (pre-incremented by caller).
 * @param getAttempt - Returns the latest attempt counter (may have changed if user cancelled).
 */
export async function handleLogin(ctx: AuthContext, attempt: number, getAttempt: () => number): Promise<void> {
  if (!ctx.client) return

  console.log("[TestAgent]  🔐 Starting login flow...")

  try {
    const dir = ctx.getWorkspaceDirectory()

    // Step 1: Initiate OAuth authorization
    const { data: auth } = await ctx.client.provider.oauth.authorize(
      { providerID: "kilo", method: 0, directory: dir },
      { throwOnError: true },
    )
    console.log("[TestAgent]  🔐 Got auth URL:", auth.url)

    // Parse code from instructions (format: "Open URL and enter code: ABCD-1234")
    const match = auth.instructions?.match(/code:\s*(\S+)/i)
    const code = match ? match[1] : undefined

    // Send device auth details to webview
    ctx.postMessage({
      type: "deviceAuthStarted",
      code,
      verificationUrl: auth.url,
      expiresIn: 900, // 15 minutes default
    })

    // Step 2: Wait for callback (blocks until polling completes)
    await ctx.client.provider.oauth.callback({ providerID: "kilo", method: 0, directory: dir }, { throwOnError: true })

    // Check if this attempt was cancelled
    if (attempt !== getAttempt()) return

    console.log("[TestAgent]  🔐 Login successful")

    await ctx.disposeGlobal()

    // testagent_change start - 登录成功后重新补齐远程接口环境变量（登出时已清理）
    await handleEnsureRemoteEnvVars(ctx.client)
    // testagent_change end

    // Step 3: Fetch profile and push to webview
    // testagent_change start - disable profile API (not available in testagent backend)
    // const { data: profile } = await ctx.client.kilo.profile(undefined, { throwOnError: true })
    // ctx.postMessage({ type: "profileData", data: profile })
    console.log("[TestAgent]  🔐 Skipping profile fetch (not available)")
    ctx.postMessage({ type: "profileData", data: null })
    // testagent_change end
    ctx.postMessage({ type: "deviceAuthComplete" })
  } catch (error) {
    if (attempt !== getAttempt()) return
    ctx.postMessage({
      type: "deviceAuthFailed",
      error: getErrorMessage(error) || "Login failed",
    })
  }
}

/** Handle logout: remove auth credentials, clear interface-fetched env vars, and clear profile. */
export async function handleLogout(ctx: AuthContext): Promise<void> {
  if (!ctx.client) return

  try {
    console.log("[TestAgent]  🚪 Logging out...")
    await ctx.client.auth.remove({ providerID: "kilo" }, { throwOnError: true })
    // testagent_change start - 登出同时清理从远程接口获取的环境变量（落盘数据 + process.env）
    await handleClearRemoteEnvVars(ctx.client)
    // testagent_change end
    console.log("[TestAgent]  🚪 Logged out successfully")
    ctx.postMessage({ type: "profileData", data: null })

    await ctx.disposeGlobal()

    await ctx.fetchAndSendProviders()
  } catch (error) {
    console.error("[TestAgent]  ❌ Logout failed:", error)
    ctx.postMessage({
      type: "error",
      message: getErrorMessage(error) || "Failed to logout",
    })
  }
}

/**
 * Handle organization switch.
 * Persists the selection and refreshes profile + providers since both change with org context.
 */
export async function handleSetOrganization(ctx: AuthContext, organizationId: string | null): Promise<void> {
  if (!ctx.client) return

  console.log("[TestAgent]  Switching organization:", organizationId ?? "personal")
  try {
    await ctx.client.kilo.organization.set({ organizationId }, { throwOnError: true })
  } catch (error) {
    console.error("[TestAgent]  Failed to switch organization:", error)
    // Re-fetch current profile to reset webview state — best-effort
    try {
      // testagent_change start - disable profile API (not available in testagent backend)
      // const result = await ctx.client.kilo.profile()
      // ctx.postMessage({ type: "profileData", data: result.data ?? null })
      console.log("[TestAgent]  👤 Skipping profile refresh (not available)")
      ctx.postMessage({ type: "profileData", data: null })
      // testagent_change end
    } catch (profileError) {
      console.error("[TestAgent]  Failed to refresh profile after org switch error:", profileError)
    }
    return
  }

  await ctx.disposeGlobal()

  // Org switch succeeded — refresh profile and providers independently (best-effort)
  try {
    // testagent_change start - disable profile API (not available in testagent backend)
    // const result = await ctx.client.kilo.profile()
    // ctx.postMessage({ type: "profileData", data: result.data ?? null })
    console.log("[TestAgent]  👤 Skipping profile refresh after org switch (not available)")
    ctx.postMessage({ type: "profileData", data: null })
    // testagent_change end
  } catch (error) {
    console.error("[TestAgent]  Failed to refresh profile after org switch:", error)
  }
  try {
    await ctx.fetchAndSendProviders()
  } catch (error) {
    console.error("[TestAgent]  Failed to refresh providers after org switch:", error)
  }
  try {
    await ctx.fetchAndSendAgents()
  } catch (error) {
    console.error("[TestAgent]  Failed to refresh agents after org switch:", error)
  }
}

/** Handle profile refresh request. */
export async function handleRefreshProfile(ctx: AuthContext): Promise<void> {
  if (!ctx.client) return

  // testagent_change start - disable profile API (not available in testagent backend)
  // console.log("[TestAgent]  🔄 Refreshing profile...")
  // const result = await ctx.client.kilo.profile().catch(() => ({ data: null }))
  // ctx.postMessage({ type: "profileData", data: result.data ?? null })
  console.log("[TestAgent]  🔄 Skipping profile refresh (not available)")
  ctx.postMessage({ type: "profileData", data: null })
  // testagent_change end
}
