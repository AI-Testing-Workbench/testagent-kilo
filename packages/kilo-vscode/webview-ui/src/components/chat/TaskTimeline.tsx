/**
 * TaskTimeline — horizontal strip of colored bars representing session activity.
 *
 * Each bar = one Part from assistant messages.
 * Color  = part type (read=blue, write=dark blue, tool=indigo, error=red, text=gray).
 * Width  = proportional to time between parts.
 * Height = proportional to content length.
 *
 * Interactions: drag scroll, mouse wheel, auto-scroll to latest.
 *
 * No virtualization needed: SolidJS <Index> creates each element once and
 * updates bindings in place (unlike React). Even 1000+ bars are fine.
 */

import { Component, Index, createEffect, createSignal, on, onCleanup } from "solid-js"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useSession } from "../../context/session"
import { color, label } from "../../utils/timeline/colors"
import { sizes, MAX_HEIGHT } from "../../utils/timeline/sizes"
import type { Part, Message } from "../../types/messages"

export interface TimelineBar {
  bg: string
  tip: string
  width: number
  height: number
  idx: number
}

function collect(messages: Message[], parts: Record<string, Part[]>): TimelineBar[] {
  const result: Part[] = []

  for (const msg of messages) {
    if (msg.role === "user") continue
    const ps = parts[msg.id]
    if (!ps) continue
    for (const p of ps) {
      if (p.type === "step-start") continue
      result.push(p)
    }
  }

  const sz = sizes(result)
  return result.map((p, i) => ({
    bg: color(p),
    tip: label(p),
    width: sz[i]!.width,
    height: sz[i]!.height,
    idx: i,
  }))
}

export const TaskTimeline: Component = () => {
  const session = useSession()
  let ref: HTMLDivElement | undefined
  let dragging = false
  let startX = 0
  let startScroll = 0

  const messages = () => session.messages()
  const allParts = () => {
    const msgs = messages()
    const result: Record<string, Part[]> = {}
    for (const m of msgs) {
      const p = session.getParts(m.id)
      if (p.length > 0) result[m.id] = p
    }
    return result
  }

  const busy = () => session.status() === "busy"

  // testagent_change start
  // 流式期间 parts 每 ~32ms 批量更新一次;旧实现是 createMemo 全量 collect,
  // 每次批次都会对全部 part 重新分配 label/color/sizes 字符串与对象,
  // 会话越长开销越大(O(N)/批 × ~30 批/秒),是任务运行中渲染进程 CPU 与
  // GC churn 持续上涨的主因之一。这里改为:part 总数或任务状态变化时立即重算,
  // 纯文本增长最多每 1s 重算一次(高度近似,任务结束立即修正)。
  const [bars, setBars] = createSignal<TimelineBar[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSig = ""
  const refresh = () => setBars(collect(messages(), allParts()))
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  onCleanup(stop)
  createEffect(() => {
    const total = messages().reduce((n, m) => n + session.getParts(m.id).length, 0)
    const sig = `${messages().length}:${busy()}:${total}`
    if (sig !== lastSig) {
      lastSig = sig
      stop()
      refresh()
      return
    }
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, 1000)
  })
  // testagent_change end

  // Auto-scroll to the latest bar when new bars appear
  let prev = 0
  createEffect(
    on(
      () => bars().length,
      (len) => {
        if (len > prev && ref) {
          ref.scrollLeft = ref.scrollWidth
        }
        prev = len
      },
    ),
  )

  // ── Drag scroll ──────────────────────────────────────────────────
  const onPointerDown = (e: PointerEvent) => {
    if (!ref) return
    dragging = true
    startX = e.clientX
    startScroll = ref.scrollLeft
    ref.setPointerCapture(e.pointerId)
    ref.style.cursor = "grabbing"
    ref.style.userSelect = "none"
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || !ref) return
    ref.scrollLeft = startScroll - (e.clientX - startX)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!ref) return
    dragging = false
    ref.releasePointerCapture(e.pointerId)
    ref.style.cursor = "grab"
    ref.style.userSelect = ""
  }

  // ── Wheel → horizontal scroll ────────────────────────────────────
  const onWheel = (e: WheelEvent) => {
    if (!ref) return
    e.preventDefault()
    ref.scrollLeft += e.deltaY || e.deltaX
  }

  createEffect(() => {
    const el = ref
    if (!el) return
    el.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => el.removeEventListener("wheel", onWheel))
  })

  return (
    <div class="task-timeline-outer">
      <div
        ref={ref}
        class="task-timeline"
        style={{ height: `${MAX_HEIGHT}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Index each={bars()}>
          {(bar) => {
            const active = () => busy() && bar().idx === bars().length - 1
            return (
              <Tooltip value={bar().tip} placement="top">
                <div
                  class="task-timeline-bar"
                  style={{
                    width: `${bar().width}px`,
                    height: `${MAX_HEIGHT}px`,
                  }}
                >
                  <div
                    class="task-timeline-bar-fill task-timeline-bar-fill--new"
                    classList={{
                      "task-timeline-bar-fill--active": active(),
                    }}
                    style={{
                      background: bar().bg,
                      height: `${(bar().height / MAX_HEIGHT) * 100}%`,
                    }}
                  />
                </div>
              </Tooltip>
            )
          }}
        </Index>
      </div>
    </div>
  )
}
