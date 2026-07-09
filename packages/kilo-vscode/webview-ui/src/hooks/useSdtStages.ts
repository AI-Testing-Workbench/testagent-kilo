// testagent_change - new file
/**
 * Hook: 当用户在输入框中输入 /sdt-run 时，自动查询任务的阶段列表，
 * 并弹出下拉选择框让用户选择阶段。选择后回填到输入框。
 */

import { createEffect, createSignal, onCleanup } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../types/messages"

const STAGES_DEBOUNCE_MS = 200

interface VSCodeContext {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

export interface StageOption {
  stage_id: string
  stage_name: string
  description: string
}

export interface SdtStages {
  stagesResults: () => StageOption[]
  stagesIndex: () => number
  showStages: () => boolean
  loading: () => boolean
  onInput: (val: string, cursor: number) => void
  onKeyDown: (
    e: KeyboardEvent,
    textarea: HTMLTextAreaElement | undefined,
    setText: (text: string) => void,
    onSelect?: () => void,
  ) => boolean
  selectStage: (
    stage: StageOption,
    textarea: HTMLTextAreaElement,
    setText: (text: string) => void,
    onSelect?: () => void,
  ) => void
  setStagesIndex: (index: number) => void
  closeStages: () => void
  /** 用户发消息时调用，取消 pending 请求并忽略 in-flight 响应 */
  cancelPending: () => void // testagent_change - add cancelPending to SdtStages
}

/** 匹配以 /sdt-run 开头的文本 */
const SDT_RUN_PATTERN = /^\/sdt-run\s*/

/**
 * Hook: 当用户在输入框中输入 /sdt-run 时，自动查询任务的阶段列表，
 * 并弹出下拉选择框让用户选择阶段。选择后回填到输入框。
 */
export function useSdtStages(vscode: VSCodeContext, sessionID?: () => string | undefined): SdtStages {
  const [stagesResults, setStagesResults] = createSignal<StageOption[]>([])
  const [stagesIndex, setStagesIndex] = createSignal(0)
  const [showStages, setShowStages] = createSignal(false)
  const [loading, setLoading] = createSignal(false)

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchCounter = 0

  // 关闭 dropdown 时重置 index
  createEffect(() => {
    if (!showStages()) setStagesIndex(0)
  })

  // 监听 extension 返回的阶段列表
  const unsubscribe = vscode.onMessage((message) => {
    if (message.type !== "stagesResult") return
    if (message.requestId === `stages-search-${searchCounter}`) {
      setStagesResults(message.stages ?? [])
      setLoading(false)
      setStagesIndex(0)
      // 仅在查询到阶段列表时才显示下拉框
      if (message.stages && message.stages.length > 0) {
        setShowStages(true)
      }
    }
  })

  onCleanup(() => {
    unsubscribe()
    if (searchTimer) clearTimeout(searchTimer)
  })

  // 向 extension 请求阶段列表
  const requestStages = () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchCounter++
      setLoading(true)
      const id = sessionID?.()
      vscode.postMessage({
        type: "requestStages",
        requestId: `stages-search-${searchCounter}`,
        ...(id ? { sessionID: id } : {}),
      })
    }, STAGES_DEBOUNCE_MS)
  }

  const closeStages = () => {
    setShowStages(false)
    setStagesResults([])
    setLoading(false)
    // testagent_change start - cancelPending:
    // 递增 counter，使所有 in-flight 响应的 requestId 失效
    searchCounter++
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = undefined
    }
    // testagent_change end
  }

  // testagent_change start - add cancelPending to SdtStages
  /** 用户在 handleSend 中调用：取消 pending 请求并忽略 in-flight 响应 */
  const cancelPending = () => {
    closeStages()
  }
  // testagent_change end

  /** 选择某个阶段后，将输入框内容替换为 /sdt-run <stage_id> */
  const selectStage = (
    stage: StageOption,
    textarea: HTMLTextAreaElement,
    setText: (text: string) => void,
    onSelect?: () => void,
  ) => {
    const text = `/sdt-run ${stage.stage_id}`
    textarea.value = text
    setText(text)

    const pos = text.length
    textarea.setSelectionRange(pos, pos)
    textarea.focus()

    closeStages()
    onSelect?.()
  }

  const onInput = (val: string, _cursor: number) => {
    // 仅当 /sdt-run 后面没有参数时（刚选择命令/刚输入完），才触发下拉列表
    if (SDT_RUN_PATTERN.test(val)) {
      const rest = val.trim().slice('/sdt-run'.length).trim()
      if (rest.length > 0) {
        // 已经有阶段参数了（用户已选择了一个 stage 或在手动输入），关闭下拉框
        if (showStages()) closeStages()
        return
      }

      // 首次检测到 /sdt-run 且无参数时请求阶段列表
      if (stagesResults().length === 0 && !loading()) {
        setShowStages(true)
        requestStages()
      } else if (stagesResults().length > 0) {
        // 已有缓存数据，直接显示下拉框
        setShowStages(true)
      }
    } else {
      closeStages()
    }
  }

  const onKeyDown = (
    e: KeyboardEvent,
    textarea: HTMLTextAreaElement | undefined,
    setText: (text: string) => void,
    onSelect?: () => void,
  ): boolean => {
    if (!showStages()) return false
    if (e.isComposing) return false

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setStagesIndex((i) => Math.min(i + 1, Math.max(stagesResults().length - 1, 0)))
      return true
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setStagesIndex((i) => Math.max(i - 1, 0))
      return true
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const result = stagesResults()[stagesIndex()]
      if (!result) return false
      e.preventDefault()
      if (textarea) selectStage(result, textarea, setText, onSelect)
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      closeStages()
      return true
    }

    return false
  }

  return {
    stagesResults,
    stagesIndex,
    showStages,
    loading,
    onInput,
    onKeyDown,
    selectStage,
    setStagesIndex,
    closeStages,
    cancelPending, // testagent_change - add cancelPending to SdtStages
  }
}