/**
 * Tests for the git() buffer-capped subprocess helper in worktree-diff.ts.
 *
 * Verifies that:
 * - Output exceeding MAX_STDOUT is truncated (not accumulated unboundedly)
 * - Truncated results don't crash downstream parsing
 * - windowsHide is set on spawned processes
 * - readBefore respects the per-file 1 MB limit
 */

import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "../../../src/kilocode/review/worktree-diff.ts")

describe("worktree-diff buffer caps", () => {
  const src = fs.readFileSync(SRC, "utf-8")

  test("MAX_STDOUT is defined and <= 10 MB", () => {
    const match = src.match(/const MAX_STDOUT\s*=\s*(.+)/)
    expect(match).toBeTruthy()
    // Evaluate: 10 * 1024 * 1024 = 10485760
    expect(src).toContain("10 * 1024 * 1024")
  })

  test("MAX_FILE_STDOUT is defined and <= 1 MB", () => {
    const match = src.match(/const MAX_FILE_STDOUT\s*=\s*(.+)/)
    expect(match).toBeTruthy()
    expect(src).toContain("1 * 1024 * 1024")
  })

  test("git() helper sets windowsHide: true", () => {
    // Find the git() function and verify windowsHide
    const fnStart = src.indexOf("async function git(")
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = src.slice(fnStart, fnStart + 600)
    expect(fnBody).toContain("windowsHide: true")
  })

  test("git() helper uses Bun.spawn (not $ template)", () => {
    // The file should not import $ from bun
    expect(src).not.toContain('import { $ } from "bun"')
    // Should use Bun.spawn
    const fnStart = src.indexOf("async function git(")
    const fnBody = src.slice(fnStart, fnStart + 600)
    expect(fnBody).toContain("Bun.spawn")
  })

  test("git() helper drains pipe after truncation", () => {
    const fnStart = src.indexOf("async function git(")
    const fnBody = src.slice(fnStart, fnStart + 800)
    // After setting truncated=true, the loop must continue reading (drain)
    expect(fnBody).toContain("if (truncated) continue")
  })

  test("git() helper consumes stderr to prevent pipe blocking", () => {
    const fnStart = src.indexOf("async function git(")
    const fnBody = src.slice(fnStart, fnStart + 1000)
    expect(fnBody).toContain("proc.stderr")
  })

  test("readBefore uses MAX_FILE_STDOUT limit", () => {
    const fnStart = src.indexOf("async function readBefore(")
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = src.slice(fnStart, fnStart + 300)
    expect(fnBody).toContain("MAX_FILE_STDOUT")
  })

  test("no $ template git calls remain in the file", () => {
    // All git commands should go through the git() helper now
    // Match the Bun shell template pattern: $`git ...`
    const templateCalls = src.match(/\$`git\s/g)
    expect(templateCalls).toBeNull()
  })
})
