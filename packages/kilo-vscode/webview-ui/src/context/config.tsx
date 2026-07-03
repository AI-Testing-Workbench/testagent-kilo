/**
 * Config context
 * Manages backend configuration state (permissions, agents, providers, etc.)
 * and exposes an updateConfig method to apply partial updates.
 *
 * Changes are accumulated in local drafts (one per scope) and only sent to
 * the extension when saveConfig() is called. This allows batching multiple
 * settings changes into a single write.
 *
 * Scope-aware saving: the webview maintains both a global and a project-level
 * config received from the server. When saving, each changed key is routed to
 * its original scope via the overlayUpdate API.
 */

import { createContext, useContext, createSignal, onCleanup } from "solid-js"
import type { ParentComponent, Accessor } from "solid-js"
import { useVSCode } from "./vscode"
import type { Config, ExtensionMessage } from "../types/messages"
import { deepMerge, stripNulls, resolveConfig } from "../utils/config-utils"
import { splitConfigByScope, configUnsetPaths, pruneConfigSet } from "../utils/config-scope"

export interface SaveError {
  message: string
  details?: string
}

interface ConfigContextValue {
  config: Accessor<Config>
  globalConfig: Accessor<Config>
  projectConfig: Accessor<Config>
  loading: Accessor<boolean>
  isDirty: Accessor<boolean>
  saving: Accessor<boolean>
  saveError: Accessor<SaveError | null>
  updateConfig: (partial: Partial<Config>) => void
  saveConfig: () => void
  discardConfig: () => void
}

export const ConfigContext = createContext<ConfigContextValue>()

export const ConfigProvider: ParentComponent = (props) => {
  const vscode = useVSCode()

  const [config, setConfig] = createSignal<Config>({})
  const [globalConfig, setGlobalConfig] = createSignal<Config>({})
  const [projectConfig, setProjectConfig] = createSignal<Config>({})
  const [loading, setLoading] = createSignal(true)
  const [draft, setDraft] = createSignal<Partial<Config>>({})
  const [isDirty, setIsDirty] = createSignal(false)
  // Last configs received from the server — used to revert on discard
  const [saved, setSaved] = createSignal<Config>({})
  const [savedGlobal, setSavedGlobal] = createSignal<Config>({})
  const [savedProject, setSavedProject] = createSignal<Config>({})
  // True while a saveConfig() write is in-flight — used to clear draft on success
  // and to guard against stale configLoaded messages overwriting optimistic state.
  const [saving, setSaving] = createSignal(false)
  // Error from the most recent saveConfig() attempt, or null if no error.
  // Cleared when the user edits the draft again or starts a new save.
  const [saveError, setSaveError] = createSignal<SaveError | null>(null)

  // Register handler immediately (not in onMount) so we never miss
  // a configLoaded message that arrives before the DOM mount.
  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "configLoaded") {
      if (saving()) return

      if (message.refresh) {
        setDraft({})
        setIsDirty(false)
        setConfig(message.config)
        setSaved(message.config)
        if (message.globalConfig) {
          setGlobalConfig(message.globalConfig)
          setSavedGlobal(message.globalConfig)
        }
        if (message.projectConfig) {
          setProjectConfig(message.projectConfig)
          setSavedProject(message.projectConfig)
        }
        setLoading(false)
        return
      }

      setConfig(resolveConfig(message.config, draft(), isDirty()))
      setSaved(message.config)
      if (message.globalConfig) {
        setGlobalConfig(message.globalConfig)
        setSavedGlobal(message.globalConfig)
      }
      if (message.projectConfig) {
        setProjectConfig(message.projectConfig)
        setSavedProject(message.projectConfig)
      }
      setLoading(false)
      return
    }
    if (message.type === "configUpdated") {
      if (saving()) {
        setSaving(false)
        setDraft({})
        setIsDirty(false)
        setSaveError(null)
        setConfig(message.config)
        if (message.globalConfig) {
          setGlobalConfig(message.globalConfig)
          setSavedGlobal(message.globalConfig)
        }
        if (message.projectConfig) {
          setProjectConfig(message.projectConfig)
          setSavedProject(message.projectConfig)
        }
      } else {
        setConfig(resolveConfig(message.config, draft(), isDirty()))
        if (message.globalConfig) {
          setGlobalConfig(message.globalConfig)
          setSavedGlobal(message.globalConfig)
        }
        if (message.projectConfig) {
          setProjectConfig(message.projectConfig)
          setSavedProject(message.projectConfig)
        }
      }
      setSaved(message.config)
      return
    }
    if (message.type === "configUpdateFailed") {
      setSaving(false)
      setSaveError({ message: message.message, details: message.details })
      return
    }
  })

  onCleanup(unsubscribe)

  vscode.postMessage({ type: "requestConfig" })

  const fallback = setTimeout(() => {
    if (loading()) {
      vscode.postMessage({ type: "requestConfig" })
    }
  }, 3000)

  const unsubReady = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "extensionDataReady") return
    unsubReady()
    clearTimeout(fallback)
    if (loading()) {
      vscode.postMessage({ type: "requestConfig" })
    }
  })

  onCleanup(() => {
    unsubReady()
    clearTimeout(fallback)
  })

  function updateConfig(partial: Partial<Config>) {
    setConfig((prev) => stripNulls(deepMerge(prev, partial)))
    setDraft((prev) => deepMerge(prev as Config, partial))
    setIsDirty(true)
    setSaveError(null)
  }

  function saveConfig() {
    const changes = draft()
    if (Object.keys(changes).length === 0) return
    setSaving(true)
    setSaveError(null)

    // Split changes by scope using key rules + real project config
    const split = splitConfigByScope(changes, projectConfig() as Record<string, unknown>)

    vscode.postMessage({
      type: "updateConfig",
      config: pruneConfigSet(split.global as Record<string, unknown>) as Config,
      projectConfig: Object.keys(split.project).length > 0
        ? (pruneConfigSet(split.project as Record<string, unknown>) as Config)
        : undefined,
      globalUnset: configUnsetPaths(split.global as Record<string, unknown>),
      projectUnset: configUnsetPaths(split.project as Record<string, unknown>),
    })
  }

  function discardConfig() {
    setConfig(saved())
    setGlobalConfig(savedGlobal())
    setProjectConfig(savedProject())
    setDraft({})
    setIsDirty(false)
    setSaveError(null)
  }

  const value: ConfigContextValue = {
    config,
    globalConfig,
    projectConfig,
    loading,
    isDirty,
    saving,
    saveError,
    updateConfig,
    saveConfig,
    discardConfig,
  }

  return <ConfigContext.Provider value={value}>{props.children}</ConfigContext.Provider>
}

export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider")
  }
  return context
}
