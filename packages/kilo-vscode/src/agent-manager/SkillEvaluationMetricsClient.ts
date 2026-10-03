/** Metrics persisted for a Skill evaluation session. */
export interface SkillEvaluationMetrics {
  toolCalls?: number
  toolErrorCount?: number
  subagentCount?: number
  compactedCount?: number
  userPromptCount?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  hitlCount?: number
  elapsedMs?: number
}

type Body = {
  totalTokens?: unknown
  inputTokens?: unknown
  outputTokens?: unknown
  totalDurationSeconds?: unknown
  toolCallCount?: unknown
  subagentCount?: unknown
  toolErrorCount?: unknown
}

const base64 = "aHR0cHM6Ly90ZXN0aHViLW1ldHJpYy1zZXJ2aWNlLnBhYXN1YXQuY21iY2hpbmEuY24="

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function decode(): string {
  return Buffer.from(base64, "base64").toString("utf8")
}

export async function fetchSessionEvaluationMetrics(sessionId: string): Promise<Partial<SkillEvaluationMetrics>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(decode() + "/api/session-stats?sessionId=" + encodeURIComponent(sessionId), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!response.ok) throw new Error("Metric service returned HTTP " + response.status)
    const value = (await response.json()) as { returnCode?: unknown; errorMsg?: unknown; body?: Body }
    if (value.returnCode !== "SUC0000" || !value.body) {
      throw new Error(typeof value.errorMsg === "string" && value.errorMsg ? value.errorMsg : "Metric service returned no data")
    }
    const body = value.body
    const duration = number(body.totalDurationSeconds)
    return {
      toolCalls: number(body.toolCallCount),
      toolErrorCount: number(body.toolErrorCount),
      subagentCount: number(body.subagentCount),
      inputTokens: number(body.inputTokens),
      outputTokens: number(body.outputTokens),
      totalTokens: number(body.totalTokens),
      elapsedMs: duration === undefined ? undefined : duration * 1000,
    }
  } finally {
    clearTimeout(timer)
  }
}