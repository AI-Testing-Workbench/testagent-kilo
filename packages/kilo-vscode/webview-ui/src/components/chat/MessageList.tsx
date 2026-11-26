/**
 * MessageList component
 * Scrollable transcript with row-level virtualization.
 * Turns are split into small rows (user / assistant part chunks / timing /
 * error / diff) by transcriptRows(); completed history and stable live chunks
 * are virtualized, while the growing tail of the active turn renders directly
 * outside the virtualizer so measurement corrections cannot fight the
 * bottom-pinned auto-scroll.
 * Shows recent sessions in the empty state for quick resumption.
 */

import { type Component, type JSX, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { createAutoScroll } from "@kilocode/kilo-ui/hooks"
import { useSession } from "../../context/session"
import { useServer } from "../../context/server"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
import { FeedbackDialog } from "./FeedbackDialog"
import { TranscriptRowView } from "./TranscriptRow"
import { createRowHandoff } from "./transcript-row-handoff"
import { RevertBanner } from "./RevertBanner"
import { AccountSwitcher } from "../shared/AccountSwitcher"
import { KiloNotifications } from "./KiloNotifications"
import { WorkingIndicator } from "../shared/WorkingIndicator"
import { QuestionDock } from "./QuestionDock"
import { CloudLogo } from "../shared/CloudLogo"
import { SandboxBrowserBanner } from "./SandboxBrowserBanner" // testagent_change
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { SuggestBar } from "./SuggestBar"
import {
  activeUserMessageID as getActiveUserMessageID,
  messageTurns,
  queuedUserMessageIDs,
  stableTurns,
  type MessageTurn,
} from "../../context/session-queue"
import {
  closedTurns,
  partitionRows,
  retainTurn,
  transcriptRows,
  type TranscriptHold,
  type TranscriptRow,
} from "../../context/transcript-rows"
import type { QuestionRequest, SuggestionRequest } from "../../types/messages"
import { PromptRail } from "./PromptRail"
import {
  capacity,
  historyAction,
  promptItems,
  railEntries,
  type PromptRailEntry,
  type PromptRailItem,
} from "./prompt-rail"
import {
  getMeasurement,
  getScroll,
  layoutFingerprint,
  resolveAnchor,
  rowFingerprint,
  setMeasurement,
  setScroll,
} from "./transcript-cache"

interface MessageListProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
  onForkMessage?: (sessionId: string, messageId: string) => void
  /** Non-tool question requests to render inline at the bottom of the message list */
  questions?: () => QuestionRequest[]
  /** Non-tool suggestion requests to render inline at the bottom of the message list */
  suggestions?: () => SuggestionRequest[]
  /** When true (subagent viewer), replace the welcome screen with an initializing indicator */
  readonly?: boolean
}

/**
 * Container for Virtua rows. Virtua sizes it from estimated row heights and
 * places rows inside it. A row that mounts taller than its estimate overflows
 * the container and grows the scroller; the bottom pin then scrolls the row
 * out of range before it is measured, and this repeats every frame. Clipping
 * vertically (chat-layout.css) makes only measured sizes set the scroll height.
 */
const VirtualBox: Component<{
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void)
  style?: JSX.CSSProperties
  children?: JSX.Element
}> = (box) => (
  <div ref={box.ref} style={box.style} data-slot="message-list-virtual">
    {box.children}
  </div>
)

export const MessageList: Component<MessageListProps> = (props) => {
  const session = useSession()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()

  const autoScroll = createAutoScroll({
    working: () => session.status() !== "idle",
  })

  // Resume auto-scroll when a bottom-dock permission/question is dismissed
  const onResumeAutoScroll = () => autoScroll.resume()
  window.addEventListener("resumeAutoScroll", onResumeAutoScroll)
  onCleanup(() => window.removeEventListener("resumeAutoScroll", onResumeAutoScroll))

  let loaded = false
  createEffect(() => {
    if (!loaded && server.isConnected() && session.sessions().length === 0) {
      loaded = true
      session.loadSessions()
    }
  })

  const [scrollEl, setScrollEl] = createSignal<HTMLElement>()
  const [virtualizer, setVirtualizer] = createSignal<VirtualizerHandle>()
  const [height, setHeight] = createSignal(0)
  const [layout, setLayout] = createSignal<string>()

  const boundary = () => session.revert()?.messageID
  const turns = createMemo((prev: MessageTurn[] | undefined) =>
    stableTurns(prev, messageTurns(session.messages(), boundary())),
  )
  const isEmpty = () => turns().length === 0 && !session.loading() && !boundary()

  const recent = createMemo(() =>
    [...session.sessions()]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 3),
  )

  const activeUserID = createMemo(() => getActiveUserMessageID(session.messages(), session.statusInfo()))
  const queuedIDs = createMemo(() => new Set(queuedUserMessageIDs(session.messages(), session.statusInfo())))
  const closedIDs = createMemo(() => closedTurns(session.messages()))

  const rows = createMemo((prev: TranscriptRow[] | undefined) => {
    const id = activeUserID()
    return transcriptRows(
      turns(),
      session.getParts,
      {
        queued: queuedIDs(),
        live: id ? new Set([id]) : new Set<string>(),
        closed: closedIDs(),
        idle: session.status() === "idle",
      },
      prev,
    )
  })

  // The active turn keeps rendering directly after it stops being active
  // (next turn starts) so its rows hand off to the virtualizer once, not per step.
  const [held, setHeld] = createSignal<TranscriptHold>()
  createEffect(() => {
    const id = activeUserID()
    const sid = session.currentSessionID()
    const paused = autoScroll.userScrolled()
    setHeld((prev) => retainTurn(prev, sid, id, paused))
  })
  const direct = createMemo(() => {
    const item = held()
    const ids = new Set<string>()
    if (item && item.sid === session.currentSessionID()) ids.add(item.turn)
    const active = activeUserID()
    if (active) ids.add(active)
    return ids
  })
  const partition = createMemo(() => partitionRows(rows(), direct()))
  const tail = createMemo(() => partition().direct.map((row) => row.key))
  const lookup = createMemo(() => new Map(rows().map((row) => [row.key, row])))
  const keys = createMemo(() => partition().virtual.map((row) => row.key))
  const indexes = createMemo(() => new Map(keys().map((key, index) => [key, index])))
  const fingerprint = createMemo(() => rowFingerprint(keys()))

  // virtua 0.42 has no findItemIndex; binary-search getItemOffset for the
  // first virtual row starting at or above the given offset.
  const topIndex = (handle: VirtualizerHandle, count: number, offset: number) => {
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (handle.getItemOffset(mid) <= offset + 1) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  let tracked = { id: session.currentSessionID(), keys: [] as string[], fingerprint: rowFingerprint([]) }
  createEffect(() => {
    const id = session.currentSessionID()
    const current = keys()
    const value = fingerprint()
    if (!id || session.loading() || tracked.id !== id) return
    tracked = { id, keys: current, fingerprint: value }
  })

  const measurement = createMemo(() => {
    const id = session.currentSessionID()
    const token = layout()
    if (!id || !token || session.loading() || keys().length === 0) return undefined
    return getMeasurement(id, fingerprint(), token)
  })

  // Persist measured row sizes and a row-anchored scroll position per session
  // so re-entering a long transcript restores exactly where the user left off,
  // without re-measuring every row (scrollbar bounce, position drift).
  const save = (id: string | undefined, handle?: VirtualizerHandle, saved = tracked) => {
    const el = scrollEl()
    if (!id || !el || saved.id !== id) return
    const token = layout()
    if (handle && token && saved.keys.length > 0) setMeasurement(id, saved.fingerprint, token, handle.cache)
    if (!autoScroll.userScrolled()) {
      setScroll(id, { type: "bottom" })
      return
    }
    if (!handle || saved.keys.length === 0) return
    const index = topIndex(handle, saved.keys.length, handle.scrollOffset)
    const key = saved.keys[index]
    if (!key) return
    setScroll(id, { type: "anchor", key, offset: handle.scrollOffset - handle.getItemOffset(index) })
  }

  const maybeLoadOlder = () => {
    const el = scrollEl()
    if (!el || el.scrollTop > 600) return
    session.loadOlderMessages()
  }

  // A synthetic scroll only exists to let virtua re-read the offset after a
  // remount. It must not page history for the session that just became active.
  let syncing = false
  const handleScroll = () => {
    autoScroll.handleScroll()
    if (!syncing) maybeLoadOlder()
    scheduleActive()
  }

  let resize: ResizeObserver | undefined
  const refreshLayout = () => {
    const el = scrollEl()
    if (!el) return
    const style = getComputedStyle(el)
    setHeight(el.clientHeight)
    setLayout(
      layoutFingerprint({
        width: Math.round(el.clientWidth),
        ratio: window.devicePixelRatio,
        font: style.fontFamily,
        size: style.fontSize,
        line: style.lineHeight,
      }),
    )
  }
  const setScrollRef = (el: HTMLElement | undefined) => {
    resize?.disconnect()
    setScrollEl(el)
    autoScroll.scrollRef(el)
    if (!el) {
      setHeight(0)
      setLayout(undefined)
      return
    }
    refreshLayout()
    resize = new ResizeObserver(refreshLayout)
    resize.observe(el)
  }

  window.addEventListener("resize", refreshLayout)
  document.fonts?.addEventListener("loadingdone", refreshLayout)
  onCleanup(() => {
    resize?.disconnect()
    window.removeEventListener("resize", refreshLayout)
    document.fonts?.removeEventListener("loadingdone", refreshLayout)
  })

  const [pending, setPending] = createSignal<{ sid: string; key: string }>()

  // Rail/jump targets are turn ids; land on the turn's first row (user row).
  const jump = (turn: string) => {
    autoScroll.pause()
    const key = `${turn}:user`
    const index = indexes().get(key)
    if (index !== undefined) {
      const handle = virtualizer()
      if (handle) {
        setPending(undefined)
        handle.scrollToIndex(index, { align: "start" })
        return
      }
    }
    const el = scrollEl()
    const target = el?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)
    if (target) {
      setPending(undefined)
      target.scrollIntoView({ block: "start" })
      return
    }
    const sid = session.currentSessionID()
    if (sid) setPending({ sid, key })
  }

  createEffect(() => {
    const target = pending()
    if (!target) return
    if (target.sid !== session.currentSessionID()) {
      setPending(undefined)
      return
    }
    const index = indexes().get(target.key)
    const handle = virtualizer()
    if (index !== undefined && handle) {
      setPending(undefined)
      autoScroll.pause()
      handle.scrollToIndex(index, { align: "start" })
      return
    }
    const row = scrollEl()?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(target.key)}"]`)
    if (!row) return
    setPending(undefined)
    autoScroll.pause()
    row.scrollIntoView({ block: "start" })
  })

  const items = createMemo((previous: PromptRailItem[] | undefined) =>
    promptItems(turns(), session.getParts, queuedIDs(), previous),
  )
  const entries = createMemo((previous: PromptRailEntry[] | undefined) =>
    railEntries(items(), capacity(height()), session.hasOlderMessages(), previous),
  )
  const [active, setActive] = createSignal<string>()
  const [seek, setSeek] = createSignal<{ sid: string; count: number }>()
  let paging = false

  const first = () => {
    const item = items()[0]
    if (!session.hasOlderMessages()) {
      if (item) jump(item.key)
      return
    }
    const sid = session.currentSessionID()
    if (!sid || session.loadingOlderMessages()) return
    setSeek({ sid, count: session.messages().length })
    if (!session.loadOlderMessages()) setSeek(undefined)
  }

  createEffect(() => {
    const loading = session.loadingOlderMessages()
    const target = seek()
    if (!target) {
      paging = loading
      return
    }
    if (target.sid !== session.currentSessionID()) {
      paging = false
      setSeek(undefined)
      return
    }
    if (loading) {
      paging = true
      return
    }
    if (!paging) return
    paging = false
    const count = session.messages().length
    const action = historyAction(target.count, count, session.hasOlderMessages())
    if (action === "load") {
      setSeek({ sid: target.sid, count })
      if (!session.loadOlderMessages()) setSeek(undefined)
      return
    }
    const item = items()[0]
    setSeek(undefined)
    if (item) jump(item.key)
  })

  // Active rail item = the turn owning the row at the top of the viewport.
  // Binary-search virtua offsets instead of scanning mounted rows: rect reads
  // force a synchronous layout while streaming mutates the DOM every frame.
  const trackActive = () => {
    const list = items()
    if (list.length === 0) {
      setActive(undefined)
      return
    }
    const last = list.at(-1)?.turn
    const el = scrollEl()
    if (!el || el.scrollHeight <= el.clientHeight + 1) {
      setActive(last)
      return
    }
    const handle = virtualizer()
    const virtual = partition().virtual
    if (!handle || virtual.length === 0) {
      setActive(last)
      return
    }
    const offset = handle.scrollOffset
    const end = handle.getItemOffset(virtual.length - 1) + handle.getItemSize(virtual.length - 1)
    if (offset >= end) {
      // Viewport top sits in the direct tail or queued rows → latest turn.
      setActive(last)
      return
    }
    setActive(virtual[topIndex(handle, virtual.length, offset)]?.turn ?? last)
  }

  let activeFrame: number | undefined
  const scheduleActive = () => {
    if (activeFrame !== undefined) return
    activeFrame = requestAnimationFrame(() => {
      activeFrame = undefined
      trackActive()
    })
  }

  onCleanup(() => {
    if (activeFrame !== undefined) cancelAnimationFrame(activeFrame)
  })

  createEffect(() => {
    items()
    rows()
    scheduleActive()
  })

  const [pendingRestore, setPendingRestore] = createSignal<string>()

  createEffect(
    on(session.currentSessionID, (id, prev) => {
      save(prev)
      tracked = { id, keys: [], fingerprint: rowFingerprint([]) }
      setPendingRestore(id)
    }),
  )

  createEffect(() => {
    const id = pendingRestore()
    if (!id || session.loading()) return
    turns().length
    // Double-rAF: the first frame lets the browser paint the new DOM from
    // the messagesLoaded batch. The second frame restores scroll position
    // without forcing a synchronous layout reflow mid-paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pendingRestore() !== id) return
        const el = scrollEl()
        if (!el) return
        const state = getScroll(id)
        const anchor = resolveAnchor(state, keys())
        const handle = virtualizer()
        if (state?.type === "anchor" && anchor && handle) {
          handle.scrollToIndex(anchor.index, { offset: anchor.offset })
          autoScroll.pause()
        } else {
          autoScroll.forceScrollToBottom()
        }
        setPendingRestore(undefined)
        maybeLoadOlder()
      })
    })
  })

  onCleanup(() => save(session.currentSessionID()))

  const handoff = createRowHandoff()
  // Virtua keeps measured sizes by index, not by key. Give each session its
  // own instance so rows never inherit another session's sizes.
  const instance = () => (scrollEl() && partition().virtual.length > 0 ? session.currentSessionID() : undefined)
  const Row: Component<{ id: string }> = (entry) => {
    const key = entry.id
    const peeked = lookup().get(key) ?? rows().find((row) => row.key === key)
    if (!peeked) return undefined
    // testagent_change start - hydrate synchronously before the first read so the
    // row paints with store objects directly. Deferring to an effect would swap
    // stash objects for store proxies right after mount; the identity change
    // fails row equality and remounts every Part in the row (tool-card blink).
    session.hydrateParts([peeked.message.id])
    const initial = lookup().get(key) ?? peeked
    // testagent_change end
    return handoff(`${session.currentSessionID()}:${key}`, () => {
      // A removed row can outlive its map entry until the handoff cleanup.
      const row = createMemo<TranscriptRow>((previous) => lookup().get(key) ?? previous, initial)
      return (
        <TranscriptRowView
          row={row()}
          readonly={props.readonly}
          onForkMessage={props.readonly ? undefined : props.onForkMessage}
        />
      ) as unknown as HTMLElement
    })
  }

  return (
    <div class="message-list-container">
      {/* testagent_change - 沙箱下在首页顶部显示"打开沙箱浏览器"横幅 */}
      <Show when={isEmpty()}>
        <SandboxBrowserBanner />
        <div class="welcome-header">
          <AccountSwitcher class="account-switcher-welcome" />
          <KiloNotifications />
        </div>
      </Show>
      <div class="message-list" ref={setScrollRef} onScroll={handleScroll} role="log" aria-live="polite">
        <div ref={autoScroll.contentRef} class={isEmpty() ? "message-list-content-empty" : "message-list-content"}>
          <Show when={session.loading()}>
            <div class="message-list-loading" role="status">
              <Spinner />
              <span>{language.t("session.messages.loading")}</span>
            </div>
          </Show>
          <Show when={isEmpty() && props.readonly}>
            <div class="message-list-empty">
              <p class="kilo-about-text">{language.t("session.messages.initializing")}</p>
            </div>
          </Show>
          <Show when={isEmpty() && !props.readonly}>
            <div class="message-list-empty">
              <CloudLogo cloudId="home-cm" class="testagent-avatar-home" blink="home-blink" />
              <p class="kilo-about-text">{language.t("session.messages.welcome")}</p>
              <Show when={recent().length > 0 && props.onSelectSession}>
                <div class="recent-sessions">
                  <span class="recent-sessions-label">{language.t("session.recent")}</span>
                  <For each={recent()}>
                    {(s) => (
                      <button class="recent-session-item" onClick={() => props.onSelectSession?.(s.id)}>
                        <span class="recent-session-title">{s.title || language.t("session.untitled")}</span>
                        <span class="recent-session-date">{formatRelativeDate(s.updatedAt)}</span>
                      </button>
                    )}
                  </For>
                  <Show when={props.onShowHistory}>
                    <button class="show-history-btn" onClick={() => props.onShowHistory}>
                      <Icon name="history" size="small" />
                      {language.t("session.showHistory")}
                    </button>
                  </Show>
                  {/* testagent_change */}
                  {/* <button class="feedback-button" onClick={() => dialog.show(() => <FeedbackDialog />)}>
                <Icon name="bubble-5" size="small" />
                {language.t("feedback.button")}
              </button> */}
                </div>
              </Show>
            </div>
          </Show>
          <Show when={!session.loading() && !isEmpty()}>
            <Show when={session.loadingOlderMessages()}>
              <div class="message-list-page-loader" role="status">
                <Spinner />
                <span>{language.t("session.messages.loadingEarlier")}</span>
              </div>
            </Show>
            <Show when={session.hasOlderMessages() && !session.loadingOlderMessages()}>
              <button class="message-list-load-older" onClick={() => session.loadOlderMessages()}>
                {language.t("session.messages.loadEarlier")}
              </button>
            </Show>
            <Show when={partition().virtual.length > 0 || partition().direct.length > 0}>
              <div
                class="message-list-turns"
                data-loaded-messages={session.messages().length}
                data-row-count={partition().virtual.length}
                data-direct-count={partition().direct.length}
                data-queued-count={partition().queued.length}
              >
                <Show when={instance()} keyed>
                  {(sid) => {
                    let handle: VirtualizerHandle | undefined
                    // The old instance is gone before the switch effect runs,
                    // so persist its sizes and position from its own disposal.
                    onCleanup(() => save(sid, handle))
                    const ref = (next?: VirtualizerHandle) => {
                      if (next) handle = next
                      setVirtualizer(next)
                      const el = scrollEl()
                      if (!next || !el) return
                      // A new instance starts at offset 0. If the scroller is
                      // already elsewhere and does not move again, no scroll
                      // event would sync it, so report the position once.
                      queueMicrotask(() => {
                        if (virtualizer() !== next || Math.abs(el.scrollTop - next.scrollOffset) < 1) return
                        syncing = true
                        el.dispatchEvent(new Event("scroll"))
                        syncing = false
                      })
                    }
                    return (
                      <Virtualizer
                        ref={ref}
                        as={VirtualBox}
                        data={keys()}
                        scrollRef={scrollEl()}
                        shift={session.messageMutation() === "prepend"}
                        cache={measurement()}
                        overscan={10}
                        itemSize={260}
                      >
                        {(key) => <Row id={key} />}
                      </Virtualizer>
                    )
                  }}
                </Show>
                <For each={tail()}>{(key) => <Row id={key} />}</For>
              </div>
            </Show>
            <Show when={boundary()}>
              <RevertBanner />
            </Show>
            <For each={partition().queued}>
              {(row) => (
                <TranscriptRowView
                  row={row}
                  readonly={props.readonly}
                  onForkMessage={props.readonly ? undefined : props.onForkMessage}
                />
              )}
            </For>
            <WorkingIndicator />
            {/* testagent_change start - live request controls stay disabled in archive previews */}
            <Show when={!props.readonly}>
              <For each={props.questions?.()}>{(req) => <QuestionDock request={req} />}</For>
              <For each={props.suggestions?.()}>{(req) => <SuggestBar request={req} />}</For>
            </Show>
            {/* testagent_change end */}
          </Show>
        </div>
      </div>

      <PromptRail
        entries={entries}
        items={items}
        active={active}
        onSelect={(item: PromptRailItem) => jump(item.key)}
        onFirst={first}
        onLatest={() => {
          const item = items().at(-1)
          if (item) jump(item.key)
        }}
        onLoadOlder={() => session.loadOlderMessages()}
        onWheel={(deltaY: number) => {
          const el = scrollEl()
          if (el) el.scrollTop += deltaY
        }}
        height={height}
        hasOlder={session.hasOlderMessages}
        loadingOlder={session.loadingOlderMessages}
        prepending={() => session.messageMutation() === "prepend"}
        seeking={() => Boolean(seek())}
        scope={session.currentSessionID}
      />

      <Show when={autoScroll.userScrolled()}>
        <button
          class="scroll-to-bottom-button"
          onClick={() => autoScroll.resume()}
          aria-label={language.t("session.messages.scrollToBottom")}
        >
          <Icon name="arrow-down-to-line" />
        </button>
      </Show>
    </div>
  )
}
