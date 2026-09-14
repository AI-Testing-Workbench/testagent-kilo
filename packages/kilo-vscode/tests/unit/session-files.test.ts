import { describe, it, expect } from "bun:test"
import * as path from "path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { editedFiles, SessionFiles } from "../../src/agent-manager/session-files"

const root = path.resolve("/tmp/repo")
const inside = (...parts: string[]) => path.join(root, ...parts)

/** Stand-in for the HTTP transport. Only the two reads SessionFiles performs. */
function clientStub(reads: { diff?: unknown; messages?: unknown; fail?: boolean }): KiloClient {
  const reply = (value: unknown) => {
    if (reads.fail) throw new Error("offline")
    return { data: value }
  }
  return {
    session: {
      diff: async () => reply(reads.diff ?? []),
      messages: async () => reply(reads.messages ?? []),
    },
  } as unknown as KiloClient
}

const noop = () => {}

describe("editedFiles", () => {
  it("reads the absolute path from an SSE write part", () => {
    const part = {
      type: "tool",
      tool: "write",
      state: { status: "completed", input: {}, metadata: { filepath: inside("src", "a.ts") } },
    }
    expect(editedFiles(part)).toEqual([inside("src", "a.ts").replaceAll("\\", "/")])
  })

  it("reads a relative input path from a stored message part", () => {
    const part = { type: "tool", name: "edit", state: { status: "completed", input: { filePath: "src/b.ts" } } }
    expect(editedFiles(part)).toEqual(["src/b.ts"])
  })

  it("reads every file an apply_patch part reports", () => {
    const part = {
      type: "tool",
      name: "apply_patch",
      state: { status: "completed", input: {}, metadata: { files: ["src/c.ts", "docs/d.md"] } },
    }
    expect(editedFiles(part)).toEqual(["src/c.ts", "docs/d.md"])
  })

  it("ignores tools that do not write files", () => {
    expect(editedFiles({ type: "tool", tool: "read", state: { input: { filePath: "src/e.ts" } } })).toEqual([])
    expect(editedFiles({ type: "text", text: "hello" })).toEqual([])
    expect(editedFiles(undefined)).toEqual([])
  })
})

describe("SessionFiles", () => {
  it("reports a brand new session as empty rather than unknown", async () => {
    // The regression this guards: an empty change set used to be indistinguishable
    // from "could not load", so the panel fell back to showing the whole worktree.
    const files = new SessionFiles(noop)
    const touched = await files.get(clientStub({}), "new-session", root)
    expect(touched).toBeDefined()
    expect(touched!.size).toBe(0)
  })

  it("reports unknown when the server cannot be reached at all", async () => {
    const files = new SessionFiles(noop)
    expect(await files.get(clientStub({ fail: true }), "s1", root)).toBeUndefined()
  })

  it("uses the snapshot diff when there is one", async () => {
    const files = new SessionFiles(noop)
    const touched = await files.get(clientStub({ diff: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }), "s2", root)
    expect([...touched!].sort()).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("falls back to tool parts while the first turn is still in flight", async () => {
    const messages = [
      { info: {}, parts: [{ type: "tool", name: "write", state: { input: {}, metadata: { filepath: inside("x.ts") } } }] },
    ]
    const files = new SessionFiles(noop)
    const touched = await files.get(clientStub({ messages }), "s3", root)
    expect(touched!.has("x.ts")).toBe(true)
  })

  it("matches absolute tool paths against repo-relative diff paths", () => {
    const files = new SessionFiles(noop)
    files.add("s4", [inside("src", "deep", "c.ts")])
    return files.get(clientStub({}), "s4", root).then((touched) => {
      expect(touched!.has("src/deep/c.ts")).toBe(true)
    })
  })

  it("keeps live tool parts even when the server reads fail", async () => {
    const files = new SessionFiles(noop)
    files.add("s5", ["src/live.ts"])
    const touched = await files.get(clientStub({ fail: true }), "s5", root)
    expect(touched?.has("src/live.ts")).toBe(true)
  })

  it("forgets everything on clear", async () => {
    const files = new SessionFiles(noop)
    files.add("s6", ["src/a.ts"])
    files.clear()
    const touched = await files.get(clientStub({}), "s6", root)
    expect(touched!.size).toBe(0)
  })
})
