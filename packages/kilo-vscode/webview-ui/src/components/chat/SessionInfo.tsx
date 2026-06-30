/**
 * SessionInfo components
 * - ContextRing: Small SVG donut showing context usage %, placed in the action bar.
 * - SessionInfoContent: Rich tooltip panel with token breakdown.
 */

import { type Component, Show, createMemo ,createSignal} from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useSession } from "../../context/session"

import { useProvider } from "../../context/provider"
import { Identifier } from "../../utils/id"

const CIRCUMFERENCE = 2 * Math.PI * 7 // r=7 → ~43.98

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%"
  return `${((n / total) * 100).toFixed(1)}%`
}

/** Selected model's context limit */
function useContextLimit() {
  const session = useSession()
  const provider = useProvider()

  return createMemo(() => {
    const sel = session.selected()
    const model = sel ? provider.findModel(sel) : undefined
    return model?.limit?.context ?? model?.contextLength ?? 0
  })
}

/** Single-step context usage with model limit */
function useUsageData() {
  const session = useSession()
  const limit = useContextLimit()

  return createMemo(() => {
    const usage = session.contextUsage()
    if (!usage || usage.tokens === 0) return undefined
    if (limit() === 0) return undefined

    const used = Math.min(usage.tokens, limit())
    return { used, limit: limit(), pctUsed: (used / limit()) * 100 }
  })
}

/** Last assistant message's token breakdown (single-step, optional) */
function useBreakdown() {
  const session = useSession()

  return createMemo(() => {
    const msgs = session.messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.role === "assistant" && m.tokens?.breakdown) return m.tokens.breakdown
    }
    return undefined
  })
}

/** Small SVG donut showing context usage percentage, to be placed in the action bar */
export const ContextRing: Component = () => {
  const session = useSession()
  const usageData = useUsageData()
  const [showContextTooltip, setShowContextTooltip] = createSignal(false)

  const pct = createMemo(() => {
    const d = usageData()
    return d ? Math.round(d.pctUsed) : 0
  })

  const offset = createMemo(() => {
    return CIRCUMFERENCE * (1 - pct() / 100)
  })

  const color = createMemo(() => {
    const d = usageData()
    if (!d) return "var(--vscode-descriptionForeground, #888)"
    if (d.pctUsed >= 80) return "var(--vscode-errorForeground, #f14c4c)"
    if (d.pctUsed >= 50) return "var(--vscode-editorWarning-foreground, #e2b714)"
    return "var(--vscode-testing-iconPassed, #5cb85c)"
  })

  const canCompact = createMemo(() => {
    if (session.status() === "busy") return false
    if (session.messages().length === 0) return false
    if (!session.selected()) return false
    return true
  })

  

  return (
    <Tooltip value={<SessionInfoContent />} placement="top" open={showContextTooltip()} contentStyle={{ "z-index": 9999999, "pointer-events": "auto" }} >
      <Button
      class="context-ring-btn"
      aria-label={`Context: ${pct()}% used`}
      variant="ghost"
      onClick={()=>setShowContextTooltip(pre=> !pre)}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" style={{ "transform": "scale(1.3) " }}>
        <circle cx="9" cy="9" r="7" fill="none" stroke="var(--vscode-input-border, rgba(128,128,128,0.25))" stroke-width="2" />
        <circle
          cx="9" cy="9" r="7"
          fill="none"
          stroke={color()}
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={String(CIRCUMFERENCE)}
          stroke-dashoffset={offset()}
          transform="rotate(-90 9 9)"
          style={{ transition: "stroke-dashoffset 0.3s ease-out, stroke 0.3s ease-out" }}
        />
        <text
          x="9" y="11"
          text-anchor="middle"
          dominant-baseline="centravsl"
          font-size="5"
          font-weight="600"
          fill="currentColor"
        >
          {pct()}%
        </text>
      </svg>
    </Button>
    </Tooltip>
  
  )
}

/** Rich tooltip content showing full context breakdown */
export const SessionInfoContent: Component = () => {
  const usageData = useUsageData()
  const br = useBreakdown()
  const session = useSession()
  const provider = useProvider()
  const activeModel = () => provider.findModel(session.selected())
    const canCompact = createMemo(() => {
    if (session.status() === "busy") return false
    if (session.messages().length === 0) return false
    if (!session.selected()) return false
    return true
  })

  const handleClick = () => {
    if (!canCompact()) return
    const messageID = Identifier.ascending("message")
    const sessionID = session.currentSession()?.id
    if (sessionID) {
      session.addOptimistic(sessionID, messageID, "压缩会话", [])
    }
    session.compact()
  }
  return (
    <div class="session-info-tooltip">
      <div class="session-info-tooltip-header">
        <span>上下文信息</span>
      </div>
      <div class="session-info-tooltip-row">
        <span class="session-info-tooltip-sub">上下文窗口</span>
        <span>{fmt(usageData()?.used ?? 0)} / {fmt(activeModel()?.limit?.context ?? 0)} tokens</span>
        <span>{(usageData()?.pctUsed ?? 0).toFixed(0)}%</span>
      </div>
      <div class="session-info-tooltip-bar-track">
        <div class="session-info-tooltip-bar-fill" style={{ width: `${usageData()?.pctUsed ?? 0}%` }} />
      </div>
      <Show when={br()}>
        {(b) => {
          const total = b().system + b().tools + b().messages
          return (
            <div class="session-info-tooltip-breakdown">
              <div class="session-info-tooltip-section">
                <div class="session-info-tooltip-section-title">系统</div>
                <div class="session-info-tooltip-item">
                  <span>系统提示词</span>
                  <span>{pct(b().system, total)}</span>
                </div>
                <div class="session-info-tooltip-item">
                  <span>工具定义</span>
                  <span>{pct(b().tools, total)}</span>
                </div>
              </div>
              <div class="session-info-tooltip-section">
                <div class="session-info-tooltip-section-title">用户上下文</div>
                <div class="session-info-tooltip-item">
                  <span>消息</span>
                  <span>{pct(b().messages, total)}</span>
                </div>
              </div>
            </div>
          )
        }}
      </Show>
      <div class="session-info-tooltip-footer">
       <Button onClick={handleClick} 
        disabled={!canCompact()}
       >压缩会话</Button>
      </div>
    </div>
  )
}
