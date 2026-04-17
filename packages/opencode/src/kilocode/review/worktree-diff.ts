// kilocode_change - new file
import { createTwoFilesPatch } from "diff"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { FileIgnore } from "@/file/ignore"
import { Snapshot } from "@/snapshot"
import { Log } from "@/util/log"

// ---------------------------------------------------------------------------
// Git subprocess helper — caps stdout to prevent unbounded native memory growth
// ---------------------------------------------------------------------------

const MAX_STDOUT = 10 * 1024 * 1024 // 10 MB general cap
const MAX_FILE_STDOUT = 1 * 1024 * 1024 // 1 MB per-file cap (readBefore)

async function git(
  args: string[],
  cwd: string,
  limit = MAX_STDOUT,
): Promise<{ ok: boolean; stdout: string; stderr: string; truncated: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  const reader = proc.stdout.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (truncated) continue // drain pipe but don't store
    size += value.length
    if (size > limit) {
      truncated = true
      continue
    }
    chunks.push(Buffer.from(value))
  }
  const code = await proc.exited
  // Consume stderr to prevent blocking the child process pipe
  const stderr = await new Response(proc.stderr).text()
  return {
    ok: code === 0 && !truncated,
    stdout: Buffer.concat(chunks).toString(),
    stderr,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Merge-base cache — avoids redundant git spawns across polling cycles
// ---------------------------------------------------------------------------

const ancestors = new Map<string, { hash: string; expires: number }>()
const ANCESTOR_TTL = 30_000 // 30 seconds

export namespace WorktreeDiff {
  export const Item = Snapshot.FileDiff.extend({
    before: z.string(),
    after: z.string(),
    tracked: z.boolean(),
    generatedLike: z.boolean(),
    summarized: z.boolean(),
    stamp: z.string(),
  }).meta({
    ref: "WorktreeDiffItem",
  })
  export type Item = z.infer<typeof Item>

  type Status = NonNullable<Snapshot.FileDiff["status"]>

  type Meta = {
    file: string
    additions: number
    deletions: number
    status: Status
    tracked: boolean
    generatedLike: boolean
    stamp: string
  }

  function generatedLike(file: string) {
    return FileIgnore.match(file)
  }

  /** Clear the merge-base cache. Exported for testing. */
  export function clearCache() {
    ancestors.clear()
  }

  async function ancestor(dir: string, base: string, log: Log.Logger) {
    const key = `${dir}\0${base}`
    const cached = ancestors.get(key)
    if (cached && Date.now() < cached.expires) return cached.hash

    const result = await git(["merge-base", "HEAD", base], dir)
    if (!result.ok) {
      log.warn("git merge-base failed", {
        stderr: result.stderr.trim(),
        dir,
        base,
      })
      return
    }
    const hash = result.stdout.trim()
    ancestors.set(key, { hash, expires: Date.now() + ANCESTOR_TTL })
    return hash
  }

  async function stats(dir: string, ancestor: string, log: Log.Logger) {
    const result = await git(["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", ancestor], dir)
    const map = new Map<string, { additions: number; deletions: number }>()
    if (result.truncated) log.warn("git diff --numstat output truncated, counts unavailable", { dir })
    if (!result.ok) return map

    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue
      const parts = line.split("\t")
      const add = parts[0]
      const del = parts[1]
      const file = parts.slice(2).join("\t")
      if (!file) continue
      map.set(file, {
        additions: add === "-" ? 0 : parseInt(add || "0", 10),
        deletions: del === "-" ? 0 : parseInt(del || "0", 10),
      })
    }

    return map
  }

  async function list(dir: string, ancestor: string, log: Log.Logger): Promise<Meta[]> {
    const nameStatus = await git(["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", ancestor], dir)
    if (nameStatus.truncated) {
      log.warn("git diff --name-status output truncated, diff omitted", { dir })
    }
    if (!nameStatus.ok) return []

    const result: Meta[] = []
    const seen = new Set<string>()
    const stat = await stats(dir, ancestor, log)

    for (const line of nameStatus.stdout.trim().split("\n")) {
      if (!line) continue
      const parts = line.split("\t")
      const code = parts[0]
      const file = parts.slice(1).join("\t")
      if (!file || !code) continue

      seen.add(file)
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified"
      const counts = stat.get(file) ?? { additions: 0, deletions: 0 }
      result.push({
        file,
        additions: counts.additions,
        deletions: counts.deletions,
        status,
        tracked: true,
        generatedLike: generatedLike(file),
        stamp: status === "deleted" ? `deleted:${ancestor}` : await statStamp(dir, file),
      })
    }

    const untracked = await git(["ls-files", "--others", "--exclude-standard"], dir)
    if (untracked.truncated) {
      log.warn("git ls-files output truncated, untracked list incomplete", { dir })
    }
    if (!untracked.ok) {
      log.warn("git ls-files failed", { stderr: untracked.stderr.trim() })
      return result
    }

    const files = untracked.stdout.trim()
    if (files) {
      log.info("untracked files found", { count: files.split("\n").length })
    }

    for (const file of files.split("\n")) {
      if (!file || seen.has(file)) continue
      const after = Bun.file(path.join(dir, file))
      if (!(await after.exists())) continue
      result.push({
        file,
        additions: await lineCount(path.join(dir, file)),
        deletions: 0,
        status: "added",
        tracked: false,
        generatedLike: generatedLike(file),
        stamp: await statStamp(dir, file),
      })
    }

    return result
  }

  async function detailMeta(dir: string, ancestor: string, file: string): Promise<Meta | undefined> {
    const tracked = await git(["ls-files", "--error-unmatch", "--", file], dir)
    if (!tracked.ok) {
      const after = Bun.file(path.join(dir, file))
      if (!(await after.exists())) return undefined
      return {
        file,
        additions: await lineCount(path.join(dir, file)),
        deletions: 0,
        status: "added",
        tracked: false,
        generatedLike: generatedLike(file),
        stamp: await statStamp(dir, file),
      }
    }

    const nameStatus = await git(
      ["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", ancestor, "--", file],
      dir,
    )
    if (!nameStatus.ok) return undefined
    const line = nameStatus.stdout.trim().split("\n")[0]
    if (!line) return undefined

    const parts = line.split("\t")
    const code = parts[0]
    const pathPart = parts.slice(1).join("\t") || file
    if (!code) return undefined

    const numstat = await git(
      ["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", ancestor, "--", file],
      dir,
    )
    const statLine = numstat.stdout.trim().split("\n")[0]
    const stat = statLine
      ? (() => {
          const values = statLine.split("\t")
          return {
            additions: values[0] === "-" ? 0 : parseInt(values[0] || "0", 10),
            deletions: values[1] === "-" ? 0 : parseInt(values[1] || "0", 10),
          }
        })()
      : { additions: 0, deletions: 0 }

    const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified"
    return {
      file: pathPart,
      additions: stat.additions,
      deletions: stat.deletions,
      status,
      tracked: true,
      generatedLike: generatedLike(pathPart),
      stamp: status === "deleted" ? `deleted:${ancestor}` : await statStamp(dir, pathPart),
    }
  }

  function lines(text: string) {
    if (!text) return 0
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
  }

  async function lineCount(file: string) {
    let count = 0
    let size = 0
    let last = 10
    const reader = Bun.file(file).stream().getReader()

    while (true) {
      const result = await reader.read()
      if (result.done) break
      const bytes = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value)
      size += bytes.length
      for (const byte of bytes) {
        if (byte === 10) count += 1
        last = byte
      }
    }

    if (size === 0) return 0
    return last === 10 ? count : count + 1
  }

  async function statStamp(dir: string, file: string) {
    const stat = await fs.stat(path.join(dir, file)).catch(() => undefined)
    if (!stat) return `missing:${file}`
    return `${stat.size}:${stat.mtimeMs}`
  }

  async function readBefore(dir: string, ancestor: string, file: string, status: Status, log: Log.Logger) {
    if (status === "added") return ""
    const result = await git(["show", `${ancestor}:${file}`], dir, MAX_FILE_STDOUT)
    if (result.truncated) log.warn("git show output truncated, before content omitted", { file })
    return result.ok ? result.stdout : ""
  }

  async function readAfter(dir: string, file: string, status: Status) {
    if (status === "deleted") return ""
    const result = Bun.file(path.join(dir, file))
    return (await result.exists()) ? await result.text() : ""
  }

  async function load(dir: string, ancestor: string, meta: Meta, log: Log.Logger): Promise<Item> {
    const before = await readBefore(dir, ancestor, meta.file, meta.status, log)
    const after = await readAfter(dir, meta.file, meta.status)
    const additions = meta.status === "added" && meta.additions === 0 && !meta.tracked ? lines(after) : meta.additions
    return {
      file: meta.file,
      patch: createTwoFilesPatch(meta.file, meta.file, before, after),
      before,
      after,
      additions,
      deletions: meta.deletions,
      status: meta.status,
      tracked: meta.tracked,
      generatedLike: meta.generatedLike,
      summarized: false,
      stamp: meta.stamp,
    }
  }

  function summarize(meta: Meta): Item {
    return {
      file: meta.file,
      patch: "",
      before: "",
      after: "",
      additions: meta.additions,
      deletions: meta.deletions,
      status: meta.status,
      tracked: meta.tracked,
      generatedLike: meta.generatedLike,
      summarized: true,
      stamp: meta.stamp,
    }
  }

  export async function summary(input: { dir: string; base: string; log?: Log.Logger }) {
    const log = input.log ?? Log.create({ service: "worktree-diff" })
    const base = input.base
    const ancestorHash = await ancestor(input.dir, base, log)
    if (!ancestorHash) return []
    log.info("merge-base resolved", { ancestor: ancestorHash.slice(0, 12) })
    const items = await list(input.dir, ancestorHash, log)
    log.info("diff summary complete", { totalFiles: items.length })
    return items.map(summarize)
  }

  export async function detail(input: { dir: string; base: string; file: string; log?: Log.Logger }) {
    const log = input.log ?? Log.create({ service: "worktree-diff" })
    const ancestorHash = await ancestor(input.dir, input.base, log)
    if (!ancestorHash) return undefined
    const item = await detailMeta(input.dir, ancestorHash, input.file)
    if (!item) return undefined
    return await load(input.dir, ancestorHash, item, log)
  }

  export async function full(input: { dir: string; base: string; log?: Log.Logger }) {
    const log = input.log ?? Log.create({ service: "worktree-diff" })
    const base = input.base
    const ancestorHash = await ancestor(input.dir, base, log)
    if (!ancestorHash) return []
    log.info("merge-base resolved", { ancestor: ancestorHash.slice(0, 12) })
    const items = await list(input.dir, ancestorHash, log)
    const result = await Promise.all(items.map((item) => load(input.dir, ancestorHash, item, log)))
    log.info("diff complete", { totalFiles: result.length })
    return result
  }
}
