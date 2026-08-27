/**
 * ChatTip
 * Shows a configurable markdown tip above the chat input, mirroring the
 * VS Code Copilot chat tip widget. Tips come from `testagent.new.chatTips`.
 * Supports `[label](command:commandId)` links that run VS Code commands,
 * plus previous/next navigation when multiple tips are configured.
 */

import { Component, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import { useVSCode } from "../../context/vscode"
import type { ChatTipItem } from "../../types/messages"

interface VscodeState {
  dismissedTips?: string[]
}

const commandLink = /\[([^\]]+)\]\(command:([^\s)]+)\)/g

function linkifyCommands(md: string): string {
  return md.replace(
    commandLink,
    '<a href="#" data-tip-command="$2" class="tip-command-link">$1</a>',
  )
}

export const ChatTip: Component = () => {
  const vscode = useVSCode()
  const [tips, setTips] = createSignal<ChatTipItem[]>([])
  const [dismissed, setDismissed] = createSignal<Set<string>>(new Set())
  const [idx, setIdx] = createSignal(0)

  onMount(() => {
    const saved = vscode.getState<VscodeState>()?.dismissedTips
    if (saved) setDismissed(new Set(saved))
    vscode.postMessage({ type: "requestChatTips" })
  })

  // Subscribe outside onMount to catch early pushes before mount.
  const unsubscribe = vscode.onMessage((msg) => {
    if (msg.type === "chatTipsLoaded") setTips(msg.tips)
  })
  onCleanup(unsubscribe)

  const visible = createMemo(() => {
    const ignored = dismissed()
    return tips().filter((tip) => !ignored.has(tip.id ?? tip.content))
  })

  const current = createMemo(() => {
    const list = visible()
    if (list.length === 0) return undefined
    return list[idx() % list.length]
  })

  const multiple = createMemo(() => visible().length > 1)

  const prev = () => {
    const list = visible()
    if (list.length === 0) return
    setIdx((idx() - 1 + list.length) % list.length)
  }

  const next = () => {
    const list = visible()
    if (list.length === 0) return
    setIdx((idx() + 1) % list.length)
  }

  const dismiss = () => {
    const tip = current()
    if (!tip) return
    const key = tip.id ?? tip.content
    const next = new Set(dismissed())
    next.add(key)
    setDismissed(next)
    vscode.setState<VscodeState>({ dismissedTips: [...next] })
  }

  const click = (e: MouseEvent) => {
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    const anchor = target.closest<HTMLAnchorElement>("a[data-tip-command]")
    if (!anchor) return
    const command = anchor.getAttribute("data-tip-command")
    if (!command) return
    e.preventDefault()
    vscode.postMessage({ type: "chatTipAction", command })
  }

  return (
    <Show when={current()} keyed>
      {(tip) => (
        <div class="chat-tip-widget" data-component="chat-tip" onClick={click}>
          <div class="chat-tip-content">
            <Markdown text={linkifyCommands(tip.content)} />
          </div>
          <div class="chat-tip-toolbar">
            <Show when={multiple()}>
              <Tooltip value="上一条提示" placement="top">
                <IconButton icon="chevron-left" size="small" variant="ghost" aria-label="上一条提示" onClick={prev} />
              </Tooltip>
              <Tooltip value="下一条提示" placement="top">
                <IconButton icon="chevron-right" size="small" variant="ghost" aria-label="下一条提示" onClick={next} />
              </Tooltip>
            </Show>
            <Tooltip value="关闭提示" placement="top">
              <IconButton icon="close" size="small" variant="ghost" aria-label="关闭提示" onClick={dismiss} />
            </Tooltip>
          </div>
        </div>
      )}
    </Show>
  )
}
