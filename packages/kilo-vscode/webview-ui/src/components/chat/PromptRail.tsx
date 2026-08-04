/** @jsxImportSource solid-js */

import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { VList, type VListHandle } from "virtua/solid"
import { useLanguage } from "../../context/language"
import { RAIL_INSET, ROW_HEIGHT, TICK_MIN, TICK_STEP, type PromptRailEntry, type PromptRailItem } from "./prompt-rail"

interface PromptRailProps {
  entries: Accessor<PromptRailEntry[]>
  items: Accessor<PromptRailItem[]>
  active: Accessor<string | undefined>
  onSelect: (item: PromptRailItem) => void
  onFirst: () => void
  onLatest: () => void
  onLoadOlder: () => void
  onWheel: (deltaY: number) => void
  height: Accessor<number>
  hasOlder: Accessor<boolean>
  loadingOlder: Accessor<boolean>
  prepending: Accessor<boolean>
  seeking: Accessor<boolean>
  scope: Accessor<string | undefined>
}

const CLOSE_DELAY = 120
const EDGE = 12
const GAP = 8
const VIRTUAL_LIMIT = 30
const CARD_CHROME = 44
const NEAR_TOP = 200

export function PromptRail(props: PromptRailProps) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [hover, setHover] = createSignal<string>()
  const [focused, setFocused] = createSignal<number>()
  const [anchor, setAnchor] = createSignal<{ top: number; left: number; height: number }>()
  const id = createUniqueId()
  let rail: HTMLElement | undefined
  let card: HTMLDivElement | undefined
  let list: VListHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let focusFrame: number | undefined
  let revealing = false

  const items = createMemo(() => props.items())
  const entries = createMemo(() => props.entries())
  const virtualized = createMemo(() => items().length > VIRTUAL_LIMIT)
  const step = createMemo(() => {
    const count = entries().length
    if (count === 0) return TICK_STEP
    return Math.max(TICK_MIN, Math.min(TICK_STEP, Math.floor((props.height() - RAIL_INSET) / count)))
  })

  const offset = () => (virtualized() ? (list?.scrollOffset ?? 0) : (card?.scrollTop ?? 0))

  const page = (value: number) => {
    if (revealing || value > NEAR_TOP) return
    if (!props.hasOlder() || props.loadingOlder() || props.seeking()) return
    props.onLoadOlder()
  }

  const place = () => {
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    const limit = Math.max(0, Math.min(window.innerHeight - EDGE * 2, rect.height - 8))
    if (limit === 0) return
    const estimate = Math.min(items().length * ROW_HEIGHT + CARD_CHROME, limit)
    const height = virtualized() ? limit : (card?.offsetHeight ?? estimate)
    const width = card?.offsetWidth ?? Math.min(360, window.innerWidth - 40)
    const min = Math.max(EDGE, rect.top + 4)
    const max = Math.min(window.innerHeight - EDGE, rect.bottom - 4) - height
    const center = rect.top + rect.height / 2 - height / 2
    const right = rect.right + GAP
    setAnchor({
      top: max < min ? min : Math.min(Math.max(center, min), max),
      left: right + width <= window.innerWidth - EDGE ? right : Math.max(EDGE, rect.left - GAP - width),
      height: limit,
    })
  }

  const cancelClose = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const reveal = (index: number, focus = false) => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    revealing = true
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (virtualized()) {
        list?.scrollToIndex(index, { align: "center" })
        if (focus) {
          focusFrame = requestAnimationFrame(() => {
            focusFrame = undefined
            card?.querySelector<HTMLElement>(`[data-prompt-index="${index}"]`)?.focus()
          })
        }
        return
      }
      const target = card?.querySelector<HTMLElement>(`[data-prompt-index="${index}"]`)
      if (!target || !card) return
      card.scrollTop = Math.max(0, target.offsetTop - card.clientHeight / 2 + target.offsetHeight / 2)
      if (focus) target.focus()
    })
  }

  const entryItem = (entry: PromptRailEntry) => {
    if (entry.type === "prompt") return entry.item
    return items()[entry.type === "overflow" ? entry.index : 0]
  }

  const openCard = (index: number) => {
    cancelClose()
    const entry = entries()[index]
    const item = entry && entryItem(entry)
    setFocused(index)
    setHover(item?.key)
    place()
    setOpen(true)
    if (!item) return
    reveal(items().findIndex((candidate) => candidate.key === item.key))
  }

  const closeCard = () => {
    cancelClose()
    timer = setTimeout(() => {
      setOpen(false)
      setHover(undefined)
    }, CLOSE_DELAY)
  }

  onCleanup(cancelClose)
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
  })

  let scope = props.scope()
  createEffect(() => {
    const next = props.scope()
    if (next === scope) return
    scope = next
    cancelClose()
    setOpen(false)
    setHover(undefined)
    setFocused(undefined)
    setAnchor(undefined)
  })

  createEffect(() => {
    const count = entries().length
    const current = focused()
    if (current === undefined || current < count) return
    setFocused(count > 0 ? count - 1 : undefined)
  })

  createEffect(() => {
    if (!open()) return
    const resize = () => place()
    window.addEventListener("resize", resize)
    onCleanup(() => window.removeEventListener("resize", resize))
  })

  createEffect(() => {
    if (!open() || !card) return
    const id = requestAnimationFrame(() => place())
    onCleanup(() => cancelAnimationFrame(id))
  })

  let seeking = false
  createEffect(() => {
    const next = props.seeking()
    if (seeking && !next && !props.hasOlder()) {
      const item = items()[0]
      setHover(item?.key)
      if (item) reveal(0)
    }
    seeking = next
  })

  const focusItem = (entry: PromptRailEntry) => {
    const item = entryItem(entry)
    if (!item) return false
    reveal(
      items().findIndex((candidate) => candidate.key === item.key),
      true,
    )
    return true
  }

  const activate = (entry: PromptRailEntry, index: number) => {
    if (entry.type === "prompt") {
      props.onSelect(entry.item)
      return
    }
    if (entry.type === "history") {
      props.onFirst()
      return
    }
    openCard(index)
    focusItem(entry)
  }

  const keyIndex = (key: string, current: number, length: number) => {
    if (key === "ArrowDown") return Math.min(length - 1, current + 1)
    if (key === "ArrowUp") return Math.max(0, current - 1)
    if (key === "Home") return 0
    if (key === "End") return length - 1
    return undefined
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const values = entries()
    const current = focused() ?? 0
    if (event.key === "Escape") {
      event.preventDefault()
      cancelClose()
      setOpen(false)
      setHover(undefined)
      return
    }
    const entry = values[current]
    if ((event.key === "Enter" || event.key === " ") && entry) {
      event.preventDefault()
      activate(entry, current)
      return
    }
    if (event.key === "Tab" && !event.shiftKey && open() && entry && focusItem(entry)) {
      event.preventDefault()
      return
    }
    const next = keyIndex(event.key, current, values.length)
    if (next === undefined) return
    event.preventDefault()
    rail?.querySelectorAll<HTMLElement>(".prompt-rail-tick")[next]?.focus()
    openCard(next)
  }

  const label = (item: PromptRailItem, index: number) =>
    language.t("session.prompts.tick", { index: index + 1, total: items().length, prompt: item.prompt })

  const rowLabel = (item: PromptRailItem, index: number) => {
    const values = [label(item, index)]
    if (item.queued) values.push(language.t("session.prompts.queued"))
    if (!item.promoted) values.push(item.answer || language.t("session.prompts.noAnswer"))
    return values.join(". ")
  }

  const entryLabel = (entry: PromptRailEntry) => {
    if (entry.type === "prompt") return label(entry.item, entry.index)
    if (entry.type === "history") return language.t("session.prompts.first")
    return language.t("session.prompts.overflow", { count: entry.count })
  }

  const entryActive = (entry: PromptRailEntry) => {
    if (entry.type === "prompt") return entry.item.key === props.active()
    if (entry.type === "history") return false
    const index = items().findIndex((item) => item.key === props.active())
    return index >= entry.index && index < entry.index + entry.count
  }

  const selectFirst = () => {
    const item = items()[0]
    setHover(item?.key)
    if (item) reveal(0)
    props.onFirst()
  }

  const selectLatest = () => {
    const index = items().length - 1
    const item = items()[index]
    setHover(item?.key)
    if (item) reveal(index)
    props.onLatest()
  }

  const row = (item: PromptRailItem, index: Accessor<number>) => (
    <button
      type="button"
      class="prompt-rail-row"
      classList={{ "prompt-rail-row--hover": item.key === hover() }}
      data-prompt-index={index()}
      aria-label={rowLabel(item, index())}
      onMouseEnter={() => setHover(item.key)}
      onClick={() => props.onSelect(item)}
    >
      <span class="prompt-rail-row-prompt" data-queued={item.queued || undefined}>
        <Show when={item.queued}>
          <span class="prompt-rail-row-status">{language.t("session.prompts.queued")} · </span>
        </Show>
        {item.prompt}
      </span>
      <Show when={!item.promoted}>
        <span class="prompt-rail-row-answer">{item.answer || language.t("session.prompts.noAnswer")}</span>
      </Show>
    </button>
  )

  return (
    <Show when={entries().length >= 2}>
      <nav
        ref={rail}
        class="prompt-rail"
        aria-label={language.t("session.prompts.navLabel")}
        style={{ "--prompt-rail-step": `${step()}px` }}
        onMouseLeave={closeCard}
        onFocusOut={(event) => {
          if (card?.contains(event.relatedTarget as Node)) return
          closeCard()
        }}
        onKeyDown={onKeyDown}
        onWheel={(event) => {
          event.preventDefault()
          props.onWheel(event.deltaY)
        }}
      >
        <For each={entries()}>
          {(entry, index) => (
            <button
              type="button"
              class="prompt-rail-tick"
              classList={{
                "prompt-rail-tick--active": entryActive(entry),
                "prompt-rail-tick--open": open() && index() === focused(),
                "prompt-rail-tick--overflow": entry.type !== "prompt",
              }}
              data-queued={(entry.type === "prompt" && entry.item.queued) || undefined}
              aria-label={entryLabel(entry)}
              aria-haspopup="dialog"
              aria-expanded={open() && index() === focused()}
              aria-controls={open() ? id : undefined}
              tabIndex={index() === (focused() ?? 0) ? 0 : -1}
              onMouseEnter={() => openCard(index())}
              onFocus={() => openCard(index())}
              onClick={() => {
                if (entry.type === "prompt") props.onSelect(entry.item)
                if (entry.type === "history") selectFirst()
                if (entry.type === "overflow") openCard(index())
              }}
            >
              <span class="prompt-rail-tick-line" />
            </button>
          )}
        </For>
      </nav>

      <Show when={open() && anchor()}>
        {(position) => (
          <Portal>
            <div
              ref={card}
              id={id}
              class="prompt-rail-card"
              data-virtualized={virtualized() || undefined}
              role="dialog"
              aria-label={language.t("session.prompts.navLabel")}
              style={{
                top: `${position().top}px`,
                left: `${position().left}px`,
                "--prompt-rail-card-height": `${position().height}px`,
              }}
              onMouseEnter={cancelClose}
              onMouseLeave={closeCard}
              onFocusIn={cancelClose}
              onFocusOut={(event) => {
                const target = event.relatedTarget as Node | null
                if (target && (card?.contains(target) || rail?.contains(target))) return
                closeCard()
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  cancelClose()
                  setOpen(false)
                  setHover(undefined)
                  rail?.querySelectorAll<HTMLElement>(".prompt-rail-tick")[focused() ?? 0]?.focus()
                  return
                }
                const target =
                  event.target instanceof Element ? event.target.closest<HTMLElement>(".prompt-rail-row") : null
                const current = Number(target?.dataset.promptIndex)
                if (!Number.isInteger(current)) return
                const next =
                  event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)
                    ? Math.min(items().length - 1, current + 1)
                    : event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)
                      ? Math.max(0, current - 1)
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items().length - 1
                          : undefined
                if (next === undefined || next === current) return
                event.preventDefault()
                const item = items()[next]
                setHover(item?.key)
                reveal(next, true)
              }}
              onWheel={(event) => {
                revealing = false
                if (event.deltaY < 0) page(offset())
              }}
              onScroll={() => {
                if (card && !virtualized()) page(card.scrollTop)
              }}
            >
              <div class="prompt-rail-card-header">
                <span class="prompt-rail-card-title">{language.t("session.prompts.navLabel")}</span>
                <div class="prompt-rail-card-actions">
                  <Tooltip value={language.t("session.prompts.first")} placement="top">
                    <IconButton
                      icon="arrow-up"
                      label={language.t("session.prompts.first")}
                      aria-label={language.t("session.prompts.first")}
                      variant="ghost"
                      size="small"
                      disabled={props.seeking() || props.loadingOlder()}
                      onClick={selectFirst}
                    />
                  </Tooltip>
                  <Tooltip value={language.t("session.prompts.latest")} placement="top">
                    <IconButton
                      icon="arrow-down-to-line"
                      label={language.t("session.prompts.latest")}
                      aria-label={language.t("session.prompts.latest")}
                      variant="ghost"
                      size="small"
                      onClick={selectLatest}
                    />
                  </Tooltip>
                </div>
              </div>
              <Show when={props.loadingOlder() || props.seeking()}>
                <div class="prompt-rail-loading" role="status">
                  <Spinner />
                  <span>{language.t("session.messages.loadingEarlier")}</span>
                </div>
              </Show>
              <Show
                when={virtualized()}
                fallback={
                  <div class="prompt-rail-list-static">
                    <For each={items()}>{row}</For>
                  </div>
                }
              >
                <VList
                  ref={(handle) => {
                    list = handle
                  }}
                  class="prompt-rail-list"
                  data={items()}
                  itemSize={ROW_HEIGHT}
                  overscan={3}
                  shift={props.prepending()}
                  onScroll={page}
                  onScrollEnd={() => {
                    revealing = false
                  }}
                >
                  {row}
                </VList>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </Show>
  )
}
