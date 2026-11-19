import { createSignal } from "solid-js"

type Sig = [() => boolean, (v: boolean) => void]

declare global {
  var __kiloShellAutoExpand: Sig | undefined
}

// The bundler resolves this module through two import paths (the webview's
// package alias and kilo-ui's relative import), producing separate copies.
// Keeping the signal on globalThis guarantees every copy shares one source.
globalThis.__kiloShellAutoExpand ??= createSignal(false) as unknown as Sig

const [shellAutoExpand, setStore] = globalThis.__kiloShellAutoExpand

/** Whether shell tool rows expand by default (and therefore render eagerly). */
export { shellAutoExpand }

/** Webview mirror of the extension-host setting; the host persists it in globalState. */
export function setShellAutoExpand(value: boolean) {
  setStore(value)
}
