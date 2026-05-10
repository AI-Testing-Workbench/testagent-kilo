/**
 * Compile-time backend runtime selection.
 *
 * BACKEND_RUNTIME is injected by esbuild `define` at build time.
 * - "testagent-bun" → spawns bin/testagent (Bun binary)
 * - "testagent-nodejs"  → spawns node cli.mjs (Node.js + nodejs-server)
 *
 * All conditional branches are dead-code-eliminated at compile time,
 * so each VSIX only contains the relevant code path.
 */

declare const BACKEND_RUNTIME: "testagent-bun" | "testagent-nodejs"

export type Runtime = "testagent-bun" | "testagent-nodejs"

/** Resolved at compile time — never changes at runtime. */
export const runtime: Runtime = typeof BACKEND_RUNTIME !== "undefined" ? BACKEND_RUNTIME : "testagent-bun"

export function isTestagentBun(): boolean {
  return runtime === "testagent-bun"
}

export function isTestagentNodejs(): boolean {
  return runtime === "testagent-nodejs"
}
