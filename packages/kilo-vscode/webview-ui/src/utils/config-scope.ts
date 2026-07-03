/**
 * Scope-aware config utilities.
 *
 * Determines whether each changed config key belongs to the "global" scope
 * (written to ~/.config/testagent/testagent.json) or the "project" scope
 * (written to the workspace's project config file).
 *
 * Strategy: hardcoded key rules determine which top-level keys are always
 * project-scoped. For sub-keys (e.g. agent.foo), the project config is
 * checked at runtime to determine scope.
 */
import type { Config } from "../types/messages"
import { isRecord } from "./config-utils"

// Top-level config keys that persist to the project's testagent.json
// rather than the global one.
const PROJECT_SCOPED_KEYS: ReadonlySet<string> = new Set(["agent", "commit_message"])

/**
 * Split a draft of config changes into global and project scopes.
 *
 * For top-level keys: use PROJECT_SCOPED_KEYS set.
 * For nested keys (e.g. agent.foo): check against the real project config
 * to determine if the sub-key exists in project scope.
 */
export function splitConfigByScope(
  draft: Partial<Config>,
  projectCfg: Record<string, unknown> = {},
): { global: Partial<Config>; project: Partial<Config> } {
  const global: Record<string, unknown> = {}
  const project: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(draft)) {
    // Key is explicitly project-scoped
    if (PROJECT_SCOPED_KEYS.has(key)) {
      // For nested objects (like agent), split sub-keys by what exists in project config
      if (isRecord(value) && isRecord(projectCfg[key])) {
        const sub = splitNestedByScope(
          value as Record<string, unknown>,
          projectCfg[key] as Record<string, unknown>,
        )
        if (Object.keys(sub.global).length > 0) global[key] = sub.global
        if (Object.keys(sub.project).length > 0) project[key] = sub.project
      } else {
        project[key] = value
      }
      continue
    }

    // For other keys, check if they exist in project config
    if (key in projectCfg) {
      project[key] = value
    } else {
      global[key] = value
    }
  }

  return { global: global as Partial<Config>, project: project as Partial<Config> }
}

/**
 * For a nested object (e.g. agent.foo), check each sub-key against
 * the project config to determine scope.
 */
function splitNestedByScope(
  changes: Record<string, unknown>,
  projectCfg: Record<string, unknown>,
): { global: Record<string, unknown>; project: Record<string, unknown> } {
  const global: Record<string, unknown> = {}
  const project: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(changes)) {
    if (key in projectCfg) {
      // Sub-key exists in project config → project scope
      project[key] = value
    } else {
      // Sub-key doesn't exist in project → global scope
      global[key] = value
    }
  }

  return { global, project }
}

/**
 * Compute unset paths for a config patch: find all leaf keys whose value
 * is `null` (meaning "delete this key from the target scope").
 *
 * Returns an array of path segments, e.g. `[["agent", "foo", "model"]]`
 * for `{ agent: { foo: { model: null } } }`.
 */
export function configUnsetPaths(config: Record<string, unknown>): string[][] {
  const paths: string[][] = []

  function walk(obj: Record<string, unknown>, prefix: string[]) {
    for (const [key, value] of Object.entries(obj)) {
      const path = [...prefix, key]
      if (value === null) {
        paths.push(path)
      } else if (isRecord(value)) {
        walk(value as Record<string, unknown>, path)
      }
    }
  }

  walk(config, [])
  return paths
}

/**
 * Remove entries with `null` values from a config patch (they represent
 * "deleted" keys and are sent separately via configUnsetPaths).
 */
export function pruneConfigSet(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) continue
    if (isRecord(value)) {
      const pruned = pruneConfigSet(value as Record<string, unknown>)
      if (Object.keys(pruned).length > 0) result[key] = pruned
    } else {
      result[key] = value
    }
  }

  return result
}
