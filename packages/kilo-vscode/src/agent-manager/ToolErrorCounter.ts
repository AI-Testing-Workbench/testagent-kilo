function isToolError(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  if (!("type" in part) || part.type !== "tool" || !("state" in part)) return false
  const state = part.state
  return !!state && typeof state === "object" && "status" in state && state.status === "error"
}

export function countToolErrors(messages: ReadonlyArray<{ parts: readonly unknown[] }>): number {
  return messages.reduce((total, message) => total + message.parts.filter(isToolError).length, 0)
}
