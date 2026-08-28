/**
 * ChatTip
 * Shows a markdown tip above the chat input, mirroring the VS Code Copilot
 * chat tip widget. Tips come from `testagent.new.chatTipsUrl` (fetched by the
 * extension at startup). Supports `[label](command:commandId)` links that run
 * VS Code commands, plus previous/next navigation when multiple tips exist.
 * The "已读" action persists the current tip as read (it will not be shown
 * again) and closes the whole bubble for this session.
 */

import { Component, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { Markdown } from "@kilocode/kilo-ui/markdown"
import { useVSCode } from "../../context/vscode"
import type { ChatTipItem } from "../../types/messages"

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
  const [idx, setIdx] = createSignal(0)
  const [closed, setClosed] = createSignal(false)
  const [viewed, setViewed] = createSignal<Set<string>>(new Set())

  onMount(() => {
    vscode.postMessage({ type: "requestChatTips" })
  })

  // Subscribe outside onMount to catch early pushes before mount.
  const unsubscribe = vscode.onMessage((msg) => {
    if (msg.type === "chatTipsLoaded") setTips(msg.tips)
  })
  onCleanup(unsubscribe)

  const current = createMemo(() => {
    const list = tips()
    if (list.length === 0) return undefined
    return list[idx() % list.length]
  })

  // Remember every tip the user has seen (initial + prev/next pages) so the
  // "已读" action can record them all.
  createEffect(() => {
    const tip = current()
    if (!tip) return
    const key = tip.id ?? tip.content
    setViewed((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
  })

  const multiple = createMemo(() => tips().length > 1)

  const prev = () => {
    const list = tips()
    if (list.length === 0) return
    setIdx((idx() - 1 + list.length) % list.length)
  }

  const next = () => {
    const list = tips()
    if (list.length === 0) return
    setIdx((idx() + 1) % list.length)
  }

  const read = () => {
    const ids = [...viewed()]
    if (ids.length > 0) vscode.postMessage({ type: "chatTipReadMany", ids })
    setClosed(true)
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
    <Show when={!closed()}>
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
              <Tooltip value="已读" placement="top">
                <IconButton icon="check" size="small" variant="ghost" aria-label="已读" onClick={read} />
              </Tooltip>
            </div>
          </div>
        )}
      </Show>
    </Show>
  )
}
