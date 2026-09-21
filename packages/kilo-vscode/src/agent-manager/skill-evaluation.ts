export const SKILL_EVALUATION_COMMAND = "testagent.new.agentManager.prepareSkillEvaluation"
export const SKILL_EVALUATION_RESULTS_COMMAND = "testagent.new.agentManager.getSkillEvaluationResults"
export const SKILL_EVALUATION_RESULT_REFRESH_COMMAND = "testagent.new.agentManager.refreshSkillEvaluationResult"
export const SKILL_EVALUATION_RESULT_DELETE_COMMAND = "testagent.new.agentManager.deleteSkillEvaluationResult"
export const SKILL_EVALUATION_RESULT_CLEANUP_COMMAND = "testagent.new.agentManager.cleanupSkillEvaluationResult"
export const SKILL_EVALUATION_SESSION_COMMAND = "testagent.new.agentManager.openSkillEvaluationSession"

export interface SkillEvaluationVersion {
  versionId: string
  version: string
  digest: string
  artifactPath: string
}

export interface SkillEvaluationModel {
  providerID: string
  modelID: string
  name?: string
  providerName?: string
}

export interface SkillEvaluationModelOption extends SkillEvaluationModel {
  isDefault: boolean
}

export interface SkillEvaluationRequest {
  apiVersion: 1
  skillId: string
  skillName: string

  versions: SkillEvaluationVersion[]
  prompt?: string
  model?: SkillEvaluationModel
}

export interface SkillEvaluationError {
  code: string
  message: string
}

export interface SkillEvaluationResultRefreshRequest {
  skillId: string
  sessionId: string
}

export interface SkillEvaluationResultDeleteRequest {
  skillId: string
  sessionId: string
}

export interface SkillEvaluationSessionRequest {
  skillId: string
  open?: boolean
}

export interface SkillEvaluationResultCleanupRequest {
  skillId: string
}

export type SkillEvaluationParseResult =
  | { ok: true; value: SkillEvaluationRequest }
  | { ok: false; error: SkillEvaluationError }

function failure(code: string, message: string): { ok: false; error: SkillEvaluationError } {
  return { ok: false, error: { code, message } }
}

export function parseSkillEvaluation(input: unknown): SkillEvaluationParseResult {
  if (!input || typeof input !== "object") return failure("invalid_request", "Version evaluation request is required")

  const data = input as Record<string, unknown>
  if (data.apiVersion !== 1) return failure("api_version_unsupported", "Unsupported version evaluation API")
  if (typeof data.skillId !== "string" || !data.skillId.trim()) {
    return failure("invalid_request", "Skill id is required")
  }
  if (typeof data.skillName !== "string" || !data.skillName.trim()) {
    return failure("invalid_request", "Skill name is required")
  }

  if (data.prompt !== undefined && typeof data.prompt !== "string") {
    return failure("invalid_prompt", "Prompt must be a string")
  }

  if (!Array.isArray(data.versions) || data.versions.length < 1 || data.versions.length > 2) {
    return failure("invalid_versions", "Select one or two Skill versions")
  }

  const versions = data.versions.map((item) => {
    if (!item || typeof item !== "object") return undefined
    const value = item as Record<string, unknown>
    if (typeof value.versionId !== "string" || !value.versionId.trim()) return undefined
    if (typeof value.version !== "string" || !value.version.trim()) return undefined
    if (typeof value.digest !== "string" || !/^(sha256:)?[a-f0-9]{64}$/i.test(value.digest.trim())) return undefined
    if (typeof value.artifactPath !== "string" || !value.artifactPath.trim()) return undefined
    return {
      versionId: value.versionId.trim(),
      version: value.version.trim(),
      digest: value.digest.trim(),
      artifactPath: value.artifactPath.trim(),
    }
  })
  if (versions.some((item) => item === undefined)) {
    return failure(
      "invalid_versions",
      "Every selected Skill version must include an id, label, digest, and artifact path",
    )
  }

  const value = versions as SkillEvaluationVersion[]
  if (new Set(value.map((item) => item.versionId)).size !== value.length) {
    return failure("invalid_versions", "Selected Skill versions must be unique")
  }

  return {
    ok: true,
    value: {
      apiVersion: 1,
      skillId: data.skillId.trim(),
      skillName: data.skillName.trim(),
      prompt: typeof data.prompt === "string" ? data.prompt : undefined,

      versions: value,
    },
  }
}

export function parseSkillEvaluationResultRefresh(
  input: unknown,
): { ok: true; value: SkillEvaluationResultRefreshRequest } | { ok: false; error: SkillEvaluationError } {
  if (!input || typeof input !== "object")
    return failure("invalid_request", "Evaluation result refresh request is required")
  const data = input as Record<string, unknown>
  if (typeof data.skillId !== "string" || !data.skillId.trim())
    return failure("invalid_request", "Skill id is required")
  if (typeof data.sessionId !== "string" || !data.sessionId.trim())
    return failure("invalid_request", "Session id is required")
  return { ok: true, value: { skillId: data.skillId.trim(), sessionId: data.sessionId.trim() } }
}

export function parseSkillEvaluationResultDelete(
  input: unknown,
): { ok: true; value: SkillEvaluationResultDeleteRequest } | { ok: false; error: SkillEvaluationError } {
  if (!input || typeof input !== "object")
    return failure("invalid_request", "Evaluation result delete request is required")
  const data = input as Record<string, unknown>
  if (typeof data.skillId !== "string" || !data.skillId.trim())
    return failure("invalid_request", "Skill id is required")
  if (typeof data.sessionId !== "string" || !data.sessionId.trim())
    return failure("invalid_request", "Session id is required")
  return { ok: true, value: { skillId: data.skillId.trim(), sessionId: data.sessionId.trim() } }
}
export function parseSkillEvaluationSession(
  input: unknown,
): { ok: true; value: SkillEvaluationSessionRequest } | { ok: false; error: SkillEvaluationError } {
  if (!input || typeof input !== "object") return failure("invalid_request", "Evaluation session request is required")
  const data = input as Record<string, unknown>
  if (typeof data.skillId !== "string" || !data.skillId.trim())
    return failure("invalid_request", "Skill id is required")
  if (data.open !== undefined && typeof data.open !== "boolean")
    return failure("invalid_request", "The open flag must be boolean")
  return { ok: true, value: { skillId: data.skillId.trim(), open: data.open !== false } }
}

export function parseSkillEvaluationResultCleanup(
  input: unknown,
): { ok: true; value: SkillEvaluationResultCleanupRequest } | { ok: false; error: SkillEvaluationError } {
  if (!input || typeof input !== "object")
    return failure("invalid_request", "Evaluation result cleanup request is required")
  const data = input as Record<string, unknown>
  if (typeof data.skillId !== "string" || !data.skillId.trim())
    return failure("invalid_request", "Skill id is required")
  return { ok: true, value: { skillId: data.skillId.trim() } }
}
