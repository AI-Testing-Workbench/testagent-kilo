import type { KiloClient } from "@kilocode/sdk/v2/client"

export function parseQueued(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === "string")
}

export async function abortSession(input: {
  client: KiloClient
  sessionID: string
  dir: string
  queuedMessageIDs: string[]
  reason?: "completed" | "user_abort" | "error"
  // testagent_change - 取消范围："tree" 用于停止 subagent 及其子会话
  scope?: "session" | "tree"
}) {
  await input.client.session.abort(
    { sessionID: input.sessionID, directory: input.dir, reason: input.reason, scope: input.scope },
    { throwOnError: true },
  )

  for (const mid of new Set(input.queuedMessageIDs)) {
    await input.client.session
      .deleteMessage({ sessionID: input.sessionID, messageID: mid, directory: input.dir }, { throwOnError: true })
      .catch((err) => console.error("[TestAgent New]  Failed to remove queued message:", err))
  }
}
