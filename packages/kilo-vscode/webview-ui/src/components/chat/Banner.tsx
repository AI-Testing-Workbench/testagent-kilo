/** @jsxImportSource solid-js */

import { Component, For } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"

interface BannerProps {
  texts: string[]
  onClose: () => void
}

export const Banner: Component<BannerProps> = (props) => (
  <div class="skill-banner">
    <Icon name="warning" size="small" />
    <span class="skill-banner-text">
      <For each={props.texts}>{(text) => <div>{text}</div>}</For>
    </span>
    <button class="skill-banner-close" onClick={props.onClose} aria-label="关闭提示">
      <Icon name="close" size="small" />
    </button>
  </div>
)
