/**
 * WaitingForUserAvatar component
 * Animated "waiting for user" avatar (ABC cycle + pulse arcs + blinking eyes),
 * shown in place of the testagent thinking avatar while the agent is blocked
 * on a permission / question from the user.
 *
 * Ported from waiting-for-user.svg so the rAF animation runs inside the
 * webview (external SVG scripts are blocked by CSP; <img> never executes them).
 */

import { Component, onCleanup, onMount } from "solid-js"

const EYE_GRAD = "url(#eye-grad)"
const CLOUD_D = "M3,12A9,9,0,1,1,21,12A9,9,0,1,1,3,12"

const P = {
  totalPeriod: 2600,
  ratioA: 0.22,
  ratioB: 0.5,
  shakeAngle: 14,
  shakeFreqHz: 7,
  shakeJumpY: 0.46,
  squashStrength: 0.04,
  scaleMicro: 0.034,
  scaleMacro: 0.06,
  idleBreathAmp: 0.02,
  idleBreathPeriod: 5000,
  pulseLifetimeA: 760,
  pulseLifetimeB: 520,
  pulseScaleEnd: 1.54,
  pulseStrokeWidth: 0.76,
  pulseGlow: 0.36,
  pulseStartRadius: 8.9,
  pulseFadeIn: 35,
  eyeWidenAmount: 0.22,
  eyeWidenDuration: 100,
  counterRotate: true,
}

type Pulse = { id: number; bornT: number; lifetime: number; scaleEnd: number; type: "A" | "B" }

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const expPulse = (x: number, center: number, width: number) => {
  const d = (x - center) / width
  return Math.exp(-d * d)
}

const polarPoint = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
}

const arcPath = (cx: number, cy: number, r: number, startDeg: number, endDeg: number) => {
  const [x0, y0] = polarPoint(cx, cy, r, startDeg)
  const [x1, y1] = polarPoint(cx, cy, r, endDeg)
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0
  const sweep = endDeg >= startDeg ? 1 : 0
  return `M${x0.toFixed(3)} ${y0.toFixed(3)} A${r.toFixed(3)} ${r.toFixed(3)} 0 ${largeArc} ${sweep} ${x1.toFixed(3)} ${y1.toFixed(3)}`
}

export const WaitingForUserAvatar: Component = () => {
  let pulsesLayer!: SVGGElement
  let rimFlashLayer!: SVGGElement
  let gTrans!: SVGGElement
  let gRotate!: SVGGElement
  let gSquash!: SVGGElement
  let eyesCounter!: SVGGElement
  let eyeL!: SVGGElement
  let eyeR!: SVGGElement
  let glowBlur!: SVGFEGaussianBlurElement

  let pulses: Pulse[] = []
  let pulseIdCounter = 0

  const emitPulse = (type: "A" | "B", now: number) => {
    pulses.push({
      id: ++pulseIdCounter,
      bornT: now,
      lifetime: type === "A" ? P.pulseLifetimeA : P.pulseLifetimeB,
      scaleEnd: P.pulseScaleEnd,
      type,
    })
  }

  const setEyeCapsule = (g: SVGGElement, widenFactor = 1, heightFactor = 1, tilt = 0) => {
    const rx = 1.22 * widenFactor
    const ry = 1.97 * heightFactor
    g.innerHTML = `<ellipse cx="0" cy="0" rx="${rx.toFixed(3)}" ry="${ry.toFixed(3)}" fill="${EYE_GRAD}" stroke="#fff" stroke-width="0.08" stroke-opacity="0.55" transform="rotate(${tilt.toFixed(3)})"/>`
  }

  const renderPulses = (now: number) => {
    pulses = pulses.filter((p) => now - p.bornT < p.lifetime)
    let html = ""
    for (const p of pulses) {
      const ageMs = now - p.bornT
      const t = ageMs / p.lifetime
      const scale = 1 + (p.scaleEnd - 1) * easeOutCubic(t)
      const r = P.pulseStartRadius * scale
      const baseOp = p.type === "A" ? 0.34 : 0.82
      const fadeIn = P.pulseFadeIn > 0 ? Math.min(1, ageMs / P.pulseFadeIn) : 1
      const fadeOut = Math.pow(1 - t, p.type === "A" ? 1.22 : 1.55)
      const opacity = baseOp * fadeIn * fadeOut
      const wobble = p.type === "B" ? ((p.id % 3) - 1) * 7 : 0
      const strokeW = P.pulseStrokeWidth * (p.type === "A" ? 0.62 : 1)
      const segments =
        p.type === "A"
          ? [
              [-70, -34],
              [-12, 18],
              [34, 56],
            ]
          : [
              [-122, -86],
              [-48, 14],
              [42, 78],
              [130, 166],
              [190, 216],
            ]

      for (let i = 0; i < segments.length; i++) {
        const [a0, a1] = segments[i]
        const d = arcPath(12, 12, r + (i % 2) * 0.26, a0 + wobble, a1 + wobble)
        const segOp = opacity * (1 - i * 0.085)
        const stroke = p.type === "B" && i < 2 ? "url(#alert-grad)" : "url(#signal-grad)"
        html += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${strokeW.toFixed(3)}" stroke-linecap="round" stroke-opacity="${segOp.toFixed(3)}" filter="url(#pulse-glow)"/>`
      }
    }
    pulsesLayer.innerHTML = html
  }

  const renderAlertLayer = (
    phase: "A" | "B" | "C",
    phaseTms: number,
    tA: number,
    tB: number,
    tC: number,
    shakePeak: number,
    bEnvelope: number,
  ) => {
    let prep = 0
    let ping = 0
    let fade = 0
    if (phase === "A") {
      prep = easeInOutCubic(clamp(phaseTms / tA, 0, 1))
      fade = 0.48 + prep * 0.36
    } else if (phase === "B") {
      const b = clamp(phaseTms / tB, 0, 1)
      const ping1 = expPulse(b, 0.1, 0.055)
      const ping2 = expPulse(b, 0.54, 0.07)
      ping = Math.max(ping1, ping2, shakePeak * bEnvelope * 0.34)
      fade = 0.92
    } else {
      const c = clamp(phaseTms / tC, 0, 1)
      fade = (1 - easeOutCubic(c)) * 0.56
    }

    const rimOp = clamp(ping * 0.58 + prep * 0.12, 0, 0.68)
    const rimW = 0.28 + ping * 0.42
    rimFlashLayer.innerHTML =
      rimOp > 0.015
        ? `<path d="${CLOUD_D}" fill="none" stroke="url(#alert-grad)" stroke-width="${rimW.toFixed(3)}" stroke-linejoin="round" stroke-opacity="${rimOp.toFixed(3)}" filter="url(#alert-glow)"/>`
        : ""
  }

  onMount(() => {
    const t0 = performance.now()
    let lastCycleT = -1
    let emittedA = false
    let emittedBPeaks = 0
    let raf = 0

    const tick = (now: number) => {
      const tInCycle = (now - t0) % P.totalPeriod

      if (tInCycle < lastCycleT) {
        emittedA = false
        emittedBPeaks = 0
      }
      lastCycleT = tInCycle

      const tA = P.totalPeriod * P.ratioA
      const tB = P.totalPeriod * P.ratioB
      const tC = P.totalPeriod - tA - tB

      let phase: "A" | "B" | "C"
      let phaseTms: number
      if (tInCycle < tA) {
        phase = "A"
        phaseTms = tInCycle
      } else if (tInCycle < tA + tB) {
        phase = "B"
        phaseTms = tInCycle - tA
      } else {
        phase = "C"
        phaseTms = tInCycle - tA - tB
      }

      if (phase === "A" && !emittedA) {
        emitPulse("A", now)
        emittedA = true
      }
      if (phase === "B") {
        const tBSec = phaseTms / 1000
        const peakInterval = 1 / (2 * P.shakeFreqHz)
        const expectedPeaks = Math.floor((tBSec - peakInterval / 2) / peakInterval) + 1
        while (emittedBPeaks < expectedPeaks && emittedBPeaks * peakInterval + peakInterval / 2 < tB / 1000) {
          if (emittedBPeaks % 3 === 0) emitPulse("B", now)
          emittedBPeaks++
        }
      }

      let rotate = 0
      let jumpY = 0
      let burstX = 1
      let burstY = 1
      let shakePeak = 0
      let bEnvelope = 0

      if (phase === "B") {
        const tBSec = phaseTms / 1000
        const angularFreq = 2 * Math.PI * P.shakeFreqHz
        const envIn = Math.min(1, tBSec / 0.15)
        const tBTotal = tB / 1000
        const envOut = Math.min(1, (tBTotal - tBSec) / 0.2)
        const env = Math.min(envIn, envOut)
        const sinV = Math.sin(angularFreq * tBSec)
        const absSin = Math.abs(sinV)
        shakePeak = absSin
        bEnvelope = env
        rotate = P.shakeAngle * sinV * env
        jumpY = -P.shakeJumpY * Math.abs(Math.sin((angularFreq * tBSec) / 2 + Math.PI / 4)) * env
        const microFactor = 1 + P.scaleMicro * absSin * env
        const macroFactor = 1 + P.scaleMacro * Math.sin(Math.PI * clamp(tBSec / tBTotal, 0, 1))
        const squashFactor = 1 - P.squashStrength * absSin * env
        burstX = microFactor * macroFactor
        burstY = microFactor * macroFactor * squashFactor
      } else if (phase === "C") {
        const tCSec = phaseTms / 1000
        const tCTotal = tC / 1000
        const decay = Math.max(0, 1 - tCSec / tCTotal)
        const decayEased = decay * decay
        const angularFreq = 2 * Math.PI * P.shakeFreqHz * 0.7
        rotate = P.shakeAngle * decayEased * 0.5 * Math.sin(angularFreq * (tB / 1000 + tCSec))
        jumpY = 0
      }

      const breathPhase = (now / P.idleBreathPeriod) * 2 * Math.PI
      const baseBreath = 1 - P.idleBreathAmp + P.idleBreathAmp * Math.sin(breathPhase)

      const finalScaleX = baseBreath * burstX
      const finalScaleY = baseBreath * burstY

      gTrans.setAttribute("transform", `translate(0 ${jumpY.toFixed(3)})`)
      gRotate.setAttribute("transform", `rotate(${rotate.toFixed(3)} 12 12)`)
      gSquash.setAttribute(
        "transform",
        `translate(12 12) scale(${finalScaleX.toFixed(4)} ${finalScaleY.toFixed(4)}) translate(-12 -12)`,
      )

      if (P.counterRotate) {
        eyesCounter.setAttribute("transform", `rotate(${(-rotate).toFixed(3)} 12 12)`)
      } else {
        eyesCounter.removeAttribute("transform")
      }

      let widenFactor = 1
      let eyeHeight = 1
      let eyeTiltL = 0
      let eyeTiltR = 0
      if (phase === "A") {
        const remainA = tA - phaseTms
        if (remainA < P.eyeWidenDuration) {
          widenFactor = 1 + P.eyeWidenAmount * (1 - remainA / P.eyeWidenDuration)
        }
      } else if (phase === "B") {
        widenFactor = 1 + P.eyeWidenAmount * 0.92 + shakePeak * bEnvelope * 0.07
        eyeHeight = 1.04 + shakePeak * bEnvelope * 0.04
        eyeTiltL = -3.0 * bEnvelope
        eyeTiltR = 3.0 * bEnvelope
      } else if (phase === "C") {
        const fadeIn = Math.min(1, phaseTms / 120)
        widenFactor = 1 + P.eyeWidenAmount * (1 - fadeIn) * 0.5
      }

      setEyeCapsule(eyeL, widenFactor, eyeHeight, eyeTiltL)
      setEyeCapsule(eyeR, widenFactor, eyeHeight, eyeTiltR)

      glowBlur.setAttribute("stdDeviation", String(P.pulseGlow))
      renderPulses(now)
      renderAlertLayer(phase, phaseTms, tA, tB, tC, shakePeak, bEnvelope)

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  return (
    <svg class="waiting-avatar" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <style>{`
        .edge-rim-tight { stroke-opacity: .08; }
        .edge-rim-soft { stroke-opacity: .06; }
        .edge-contact { stroke-opacity: .08; }
        @media (prefers-color-scheme: light) {
          .edge-rim-tight { stroke-opacity: .15; }
          .edge-rim-soft { stroke-opacity: .10; }
          .edge-contact { stroke-opacity: .18; }
          .cloud-drop-shadow { flood-opacity: .13; }
        }
      `}</style>
      <defs>
        <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4fc3f7" />
          <stop offset="50%" stop-color="#2979ff" />
          <stop offset="100%" stop-color="#69f0ae" />
        </linearGradient>
        <radialGradient id="circle-fill" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="#e8f4ff" />
          <stop offset="100%" stop-color="#c8e0ff" />
        </radialGradient>
        <radialGradient id="hg-grad" cx="0.45" cy="0.25" r="0.55">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.9" />
          <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="eye-grad" x1="0" y1="0" x2="0" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ff6e6e" />
          <stop offset="0.5" stop-color="#f85149" />
          <stop offset="1" stop-color="#b71c1c" />
        </linearGradient>
        <linearGradient id="signal-grad" x1="-2" y1="12" x2="26" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#4fc3f7" stop-opacity="0.1" />
          <stop offset="0.22" stop-color="#4fc3f7" stop-opacity="0.92" />
          <stop offset="0.78" stop-color="#2979ff" stop-opacity="0.92" />
          <stop offset="1" stop-color="#2979ff" stop-opacity="0.1" />
        </linearGradient>
        <linearGradient id="alert-grad" x1="19" y1="4" x2="5" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#FFD36E" stop-opacity="0.98" />
          <stop offset="0.36" stop-color="#FFA56B" stop-opacity="0.9" />
          <stop offset="0.72" stop-color="#4fc3f7" stop-opacity="0.74" />
          <stop offset="1" stop-color="#2979ff" stop-opacity="0.18" />
        </linearGradient>
        <filter id="cloud-shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0.6" stdDeviation="0.8" flood-color="#2979ff" flood-opacity="0.18" />
        </filter>
        <filter id="edge-blur" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="0.16" />
        </filter>
        <filter id="pulse-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur ref={glowBlur} stdDeviation="0.22" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="alert-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="0.38" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id="cloud-clip">
          <path d={CLOUD_D} />
        </clipPath>
      </defs>

      <g ref={pulsesLayer} />

      <g ref={gTrans}>
        <g ref={gRotate}>
          <g ref={gSquash}>
            <g>
              <path
                class="edge-contact"
                d={CLOUD_D}
                fill="none"
                stroke="#4fc3f7"
                stroke-width="1.05"
                stroke-linejoin="round"
                transform="translate(0 0.18)"
                filter="url(#edge-blur)"
              />
              <path
                class="edge-rim-soft"
                d={CLOUD_D}
                fill="none"
                stroke="#4fc3f7"
                stroke-width="0.9"
                stroke-linejoin="round"
                filter="url(#edge-blur)"
              />
              <path
                class="edge-rim-tight"
                d={CLOUD_D}
                fill="none"
                stroke="#69f0ae"
                stroke-width="0.42"
                stroke-linejoin="round"
              />
            </g>
            <g filter="url(#cloud-shadow)">
              <circle cx="12" cy="12" r="9" fill="url(#circle-fill)" stroke="url(#bg-grad)" stroke-width="1.2" />
              <circle cx="12" cy="12" r="7" fill="url(#hg-grad)" opacity="0.6" />
            </g>
            <g ref={rimFlashLayer} />
            <g ref={eyesCounter}>
              <g ref={eyeL} transform="translate(9 10)" />
              <g ref={eyeR} transform="translate(15 10)" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}
