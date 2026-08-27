/**
 * CloudLogo component
 * TestAgent robot face with warm clouds at the base when cloud mode is active.
 * Shared by the homepage empty state (MessageList) and the task header avatar (TaskHeader).
 */

import { type Component, Show } from "solid-js"
import { useServer } from "../../context/server"

const CLOUD_PATH =
  "M-15.6 5.4c-2.4 0-4.4-1.8-4.4-4.0 0-1.9 1.5-3.6 3.5-4.0 .4-2.7 3.0-4.8 6.2-4.8 1.2 0 2.3 .3 3.3 .9 1.4-2.1 3.9-3.5 6.8-3.5 3.6 0 6.6 2.1 7.4 5.0 3.4 0 6.0 2.4 6.0 5.3 0 2.8-2.5 5.0-5.6 5.0H-15.6z"

interface CloudLogoProps {
  class?: string
  blink?: string
  cloudId: string
}

export const CloudLogo: Component<CloudLogoProps> = (props) => {
  const server = useServer()
  const id = (suffix: string) => `${props.cloudId}-${suffix}`
  return (
    <svg
      class={props.class}
      classList={{ "testagent-avatar-cloud": server.cloudMode() }}
      viewBox="-4 -4 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={id("rg")} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4fc3f7" />
          <stop offset="50%" stop-color="#2979ff" />
          <stop offset="100%" stop-color="#69f0ae" />
        </linearGradient>
        <Show when={server.cloudMode()}>
          <linearGradient id={id("back")} x1="0" y1="-9" x2="0" y2="9" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#FFE3CE" />
            <stop offset="0.5" stop-color="#FFD3B3" />
            <stop offset="1" stop-color="#FFB89A" />
          </linearGradient>
          <linearGradient id={id("front")} x1="0" y1="-9" x2="0" y2="9" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#FFF1CE" />
            <stop offset="0.5" stop-color="#FCE3B0" />
            <stop offset="1" stop-color="#F5C374" />
          </linearGradient>
          <radialGradient id={id("hi")} cx="32%" cy="24%" r="60%">
            <stop offset="0" stop-color="#ffffff" stop-opacity=".62" />
            <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
          </radialGradient>
          <filter id={id("shadow")} x="-80%" y="-120%" width="260%" height="340%">
            <feDropShadow dx="0" dy="0.9" stdDeviation="1.05" flood-color="#A2603C" flood-opacity=".18" />
          </filter>
        </Show>
      </defs>
      <Show when={server.cloudMode()}>
        <g transform="translate(11.0 21.41) scale(0.85)" filter={`url(#${id("shadow")})`}>
          <g class="cm-cloud-bob">
            <path
              d={CLOUD_PATH}
              fill={`url(#${id("back")})`}
              stroke="#E69E78"
              stroke-width="0.55"
              stroke-opacity="0.32"
              stroke-linejoin="round"
            />
            <ellipse cx="-3.5" cy="-4.5" rx="6" ry="2.8" fill={`url(#${id("hi")})`} opacity=".48" />
          </g>
        </g>
      </Show>
      <circle cx="12" cy="12" r="12" fill="#e8f4ff" />
      <circle cx="12" cy="12" r="12.75" fill="none" stroke={`url(#${id("rg")})`} stroke-width="1.5" />
      <ellipse class={props.blink} cx="8" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
      <ellipse class={props.blink} cx="16" cy="9.33" rx="1.63" ry="2.62" fill="#2979ff" />
      <Show when={server.cloudMode()}>
        <g transform="translate(17.88 21.41) scale(0.85)" filter={`url(#${id("shadow")})`}>
          <g class="cm-cloud-bob cm-cloud-front">
            <path
              d={CLOUD_PATH}
              fill={`url(#${id("front")})`}
              stroke="#D9A04F"
              stroke-width="0.55"
              stroke-opacity="0.36"
              stroke-linejoin="round"
            />
            <ellipse cx="-3" cy="-4" rx="5.2" ry="2.4" fill={`url(#${id("hi")})`} opacity=".55" />
          </g>
        </g>
      </Show>
    </svg>
  )
}
