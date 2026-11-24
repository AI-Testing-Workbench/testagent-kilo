import { describe, it, expect } from "bun:test"
import { pruneParts } from "../../webview-ui/src/context/part-prune"

const KEEP = 4000
const BIG = "x".repeat(200_000)

function tool(tool: string, state: Record<string, unknown>) {
  return { type: "tool", id: `p-${tool}`, tool, state }
}

describe("pruneParts", () => {
  it("returns the same array when nothing is prunable", () => {
    const parts = [tool("read", { status: "completed", input: { filePath: "/a.ts" } })]
    const result = pruneParts(parts)
    expect(result.changed).toBe(false)
    expect(result.freed).toBe(0)
    expect(result.parts).toBe(parts)
  })

  it("keeps short output untouched", () => {
    const small = "x".repeat(KEEP)
    const parts = [tool("bash", { status: "completed", output: small })]
    expect(pruneParts(parts).changed).toBe(false)
  })

  it("shrinks output to a head excerpt and reports freed chars", () => {
    const parts = [tool("bash", { status: "completed", output: BIG, metadata: { output: BIG } })]
    const result = pruneParts(parts)
    expect(result.changed).toBe(true)
    expect(result.freed).toBe((BIG.length - KEEP) * 2)
    const state = (result.parts[0] as Record<string, any>).state
    expect(state.output.startsWith("x".repeat(100))).toBe(true)
    expect(state.output).toContain("truncated")
    expect(state.output.length).toBeLessThan(KEEP + 100)
  })

  it("keeps part structure so rendering still works", () => {
    const parts = [tool("bash", { status: "completed", title: "run tests", input: { command: "bun test" }, output: BIG })]
    const result = pruneParts(parts)
    const part = result.parts[0] as Record<string, any>
    expect(part.id).toBe("p-bash")
    expect(part.type).toBe("tool")
    expect(part.tool).toBe("bash")
    expect(part.state.status).toBe("completed")
    expect(part.state.title).toBe("run tests")
    expect(part.state.input.command).toBe("bun test")
  })

  it("preserves text parts untouched", () => {
    const text = { type: "text", id: "t1", text: BIG }
    const parts = [text, tool("bash", { status: "completed", output: BIG })]
    const result = pruneParts(parts)
    expect(result.parts[0]).toBe(text)
  })

  it("ignores parts without state", () => {
    const parts = [{ type: "tool", id: "p0", tool: "bash" }]
    expect(pruneParts(parts).changed).toBe(false)
  })

  it("shrinks stdout/stderr/result variants", () => {
    const parts = [tool("bash", { status: "completed", result: BIG, stdout: BIG, stderr: BIG })]
    const state = (pruneParts(parts).parts[0] as Record<string, any>).state
    expect(state.result).toContain("truncated")
    expect(state.stdout).toContain("truncated")
    expect(state.stderr).toContain("truncated")
  })

  it("is idempotent — second pass frees nothing", () => {
    const parts = [tool("bash", { status: "completed", output: BIG })]
    const first = pruneParts(parts)
    const second = pruneParts(first.parts)
    expect(second.changed).toBe(false)
    expect(second.freed).toBe(0)
  })
})
