// testagent_change - new file
import { type Component } from "solid-js"

interface LoadingSpinnerProps {
  class?: string
  size?: "small" | "normal" | "medium" | "large"
}

export const LoadingSpinner: Component<LoadingSpinnerProps> = (props) => {
  return (
    <div data-component="icon" data-size={props.size || "normal"}>
      <svg data-slot="icon-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true" class={props.class}>
        <style>
          {`
          @keyframes loading-spinner-rotate {
            to { transform: rotate(360deg); }
          }
          .loading-spinner-circle {
            animation: loading-spinner-rotate 1s linear infinite;
            transform-origin: center;
          }
        `}
        </style>
        <g class="loading-spinner-circle">
          <circle cx="10" cy="2.5" r="1.5" opacity="1" fill="currentColor" />
          <circle cx="14.5" cy="4.5" r="1.5" opacity="0.875" fill="currentColor" />
          <circle cx="17.5" cy="10" r="1.5" opacity="0.75" fill="currentColor" />
          <circle cx="14.5" cy="15.5" r="1.5" opacity="0.625" fill="currentColor" />
          <circle cx="10" cy="17.5" r="1.5" opacity="0.5" fill="currentColor" />
          <circle cx="5.5" cy="15.5" r="1.5" opacity="0.375" fill="currentColor" />
          <circle cx="2.5" cy="10" r="1.5" opacity="0.25" fill="currentColor" />
          <circle cx="5.5" cy="4.5" r="1.5" opacity="0.125" fill="currentColor" />
        </g>
      </svg>
    </div>
  )
}
