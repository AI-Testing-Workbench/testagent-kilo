import type { ModelSelection, Provider } from "../types/messages"
import { isModelValid } from "./provider-utils"

function validate(
  providers: Record<string, Provider>,
  connected: string[],
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null
  if (Object.keys(providers).length === 0) return selection
  return isModelValid(providers, connected, selection) ? selection : null
}

function recent(
  providers: Record<string, Provider>,
  connected: string[],
  selections: ModelSelection[] | undefined,
): ModelSelection | null {
  for (const item of selections ?? []) {
    const selection = validate(providers, connected, item)
    if (selection) return selection
  }
  return null
}

/** Pick the first valid model from connected providers using the defaults map. */
function autoSelect(
  providers: Record<string, Provider>,
  connected: string[],
  defaults: Record<string, string>,
): ModelSelection | null {
  for (const providerID of connected) {
    const modelID = defaults[providerID]
    if (modelID) {
      const sel = { providerID, modelID }
      if (isModelValid(providers, connected, sel)) return sel
    }
    // fallback: first model in the provider
    const provider = providers[providerID]
    if (!provider) continue
    const first = Object.keys(provider.models)[0]
    if (first) {
      const sel = { providerID, modelID: first }
      if (isModelValid(providers, connected, sel)) return sel
    }
  }
  return null
}

export function resolveModelSelection(input: {
  providers: Record<string, Provider>
  connected: string[]
  defaults?: Record<string, string>
  override?: ModelSelection | null
  mode?: ModelSelection | null
  global?: ModelSelection | null
  recent?: ModelSelection[]
  fallback?: ModelSelection | null
}): ModelSelection | null {
  const resolved =
    validate(input.providers, input.connected, input.override) ??
    validate(input.providers, input.connected, input.mode) ??
    validate(input.providers, input.connected, input.global) ??
    recent(input.providers, input.connected, input.recent)

  if (resolved) return resolved

  // If providers are loaded and we have connected providers, auto-select
  // the first valid model instead of falling back to KILO_AUTO placeholder.
  if (Object.keys(input.providers).length > 0 && input.connected.length > 0) {
    const auto = autoSelect(input.providers, input.connected, input.defaults ?? {})
    if (auto) return auto
  }

  return input.fallback ?? null
}
