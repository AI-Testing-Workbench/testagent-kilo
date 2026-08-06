/**
 * ThinkingAvatar component
 * Animated "thinking" robot face with pulsing gradient rings.
 */

import type { Component } from "solid-js"

export const ThinkingAvatar: Component<{ class?: string }> = (props) => (
  <svg class={props.class ?? "thinking-avatar"} viewBox="-4 -4 32 32" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="ta-rg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#4fc3f7" />
        <stop offset="50%" stop-color="#2979ff" />
        <stop offset="100%" stop-color="#69f0ae" />
      </linearGradient>
      <filter id="ta-glow">
        <feGaussianBlur stdDeviation="0.8" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <circle cx="12" cy="12" r="12" fill="#e8f4ff" />
    <circle
      class="ta-ring-bg"
      cx="12"
      cy="12"
      r="12.75"
      fill="none"
      stroke="url(#ta-rg)"
      stroke-width="3"
      style="filter:url(#ta-glow)"
    />
    <circle
      class="ta-ring"
      cx="12"
      cy="12"
      r="12.75"
      fill="none"
      stroke="url(#ta-rg)"
      stroke-width="1.5"
      style="filter:url(#ta-glow)"
    />
    <g class="ta-eyes">
      <ellipse cx="9" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
      <ellipse cx="15" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
    </g>
  </svg>
)
