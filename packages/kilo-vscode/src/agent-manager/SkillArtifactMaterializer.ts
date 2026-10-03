import * as crypto from "node:crypto"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import * as zlib from "node:zlib"

export class SkillArtifactError extends Error {
  readonly code: "skill_sha_mismatch" | "skill_artifact_invalid" | "busy"
  readonly detail?: Record<string, unknown>

  constructor(
    code: "skill_sha_mismatch" | "skill_artifact_invalid" | "busy",
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "SkillArtifactError"
    this.code = code
    this.detail = detail
  }
}

export interface MaterializeInput {
  artifactPath: string
  digest: string
  skillId: string
  versionId?: string
  version?: string
  name?: string
  kind: "skill" | "skillPkg"
  worktree: string
  runId: string
  variantId: string
}

export interface MaterializeResult {
  root: string
  skills: string
  agents: string
  commands: string
  manifest: Record<string, unknown>
}

function norm(value: string): string {
  const item = value.trim().toLowerCase()
  return item.startsWith("sha256:") ? item.slice(7) : item
}

function valid(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(norm(value))
}

function inside(root: string, target: string): boolean {
  const base = path.resolve(root)
  const child = path.resolve(target)
  const rel = path.relative(base, child)
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
}

function part(value: string, label: string): string {
  if (!value || value === "." || value === ".." || value.includes("..") || /[\\/\0]/.test(value)) {
    throw new Error("Invalid artifact " + label)
  }
  return value
}

async function remove(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true })
}

async function mkdir(target: string): Promise<void> {
  const full = path.resolve(target)
  const parsed = path.parse(full)
  let current = parsed.root
  for (const item of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, item)
    const stat = await fsp.lstat(current).catch(() => undefined)
    if (stat?.isSymbolicLink()) throw new Error("Symlink encountered in destination path: " + current)
    if (!stat) await fsp.mkdir(current)
    else if (!stat.isDirectory()) throw new Error("Destination component is not a directory: " + current)
  }
}

async function files(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    const stat = await fsp.lstat(full)
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not permitted in an artifact: " + full)
    if (stat.isDirectory()) {
      await files(root, full, out)
      continue
    }
    if (!stat.isFile()) throw new Error("Unsupported artifact entry: " + full)
    out.push(path.relative(root, full).split(path.sep).join("/"))
  }
  return out
}

async function checkParents(target: string): Promise<void> {
  const full = path.resolve(target)
  const parsed = path.parse(full)
  const parts = full.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const item of parts) {
    current = path.join(current, item)
    const stat = await fsp.lstat(current).catch(() => undefined)
    if (stat?.isSymbolicLink())
      throw new SkillArtifactError("skill_artifact_invalid", "Skill artifact path may not contain symlinks", {
        path: current,
      })
  }
}

async function digest(source: string): Promise<string> {
  const stat = await fsp.lstat(source)
  if (stat.isSymbolicLink()) throw new Error("Artifact source may not be a symlink")
  if (stat.isFile())
    return crypto
      .createHash("sha256")
      .update(await fsp.readFile(source))
      .digest("hex")
  if (!stat.isDirectory()) throw new Error("Artifact source must be a file or directory")
  const sum = crypto.createHash("sha256")
  for (const rel of await files(source)) {
    sum.update(rel)
    sum.update("\0")
    sum.update(await fsp.readFile(path.join(source, rel)))
    sum.update("\0")
  }
  return sum.digest("hex")
}

async function copy(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source)
  if (stat.isSymbolicLink()) throw new Error("Symlinks are not permitted in an artifact: " + source)
  if (stat.isFile()) {
    await mkdir(path.dirname(target))
    await fsp.copyFile(source, target)
    return
  }
  if (!stat.isDirectory()) throw new Error("Unsupported artifact entry: " + source)
  await mkdir(target)
  const entries = await fsp.readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    await copy(path.join(source, entry.name), path.join(target, entry.name))
  }
}

function archivePath(root: string, name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "")
  const target = path.resolve(root, ...normalized.split("/"))
  if (!inside(root, target)) throw new Error("Archive entry escapes extraction root")
  return target
}

function zipOffset(bytes: Buffer): number {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (i >= 0 && bytes.length - i >= 22 && bytes.readUInt32LE(i) === 0x06054b50) return bytes.readUInt32LE(i + 16)
  }
  throw new Error("Invalid zip archive: central directory not found")
}

async function unzip(bytes: Buffer, root: string): Promise<void> {
  let offset = zipOffset(bytes)
  while (offset + 46 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50) {
    const method = bytes.readUInt16LE(offset + 10)
    const size = bytes.readUInt32LE(offset + 20)
    const expected = bytes.readUInt32LE(offset + 24)
    const nameSize = bytes.readUInt16LE(offset + 28)
    const extraSize = bytes.readUInt16LE(offset + 30)
    const commentSize = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString("utf8")
    offset += 46 + nameSize + extraSize + commentSize
    if (local + 30 > bytes.length) throw new Error("Invalid zip local header")
    const localName = bytes.readUInt16LE(local + 26)
    const localExtra = bytes.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    const end = start + size
    if (end > bytes.length) throw new Error("Invalid zip entry size")
    const target = archivePath(root, name)
    if (name.endsWith("/")) {
      await mkdir(target)
      continue
    }
    const compressed = bytes.subarray(start, end)
    const content = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : undefined
    if (!content) throw new Error("Unsupported zip compression method: " + method)
    if (expected !== 0 && content.length !== expected) throw new Error("Invalid zip entry size: " + name)
    await mkdir(path.dirname(target))
    await fsp.writeFile(target, content)
  }
}

function tarText(bytes: Buffer, start: number, size: number): string {
  return bytes
    .subarray(start, start + size)
    .toString("utf8")
    .replace(/\0.*$/, "")
    .trim()
}

function tarNum(bytes: Buffer, start: number, size: number): number {
  const value = tarText(bytes, start, size)
  return value ? parseInt(value, 8) : 0
}

async function untar(bytes: Buffer, root: string): Promise<void> {
  let offset = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((item) => item === 0)) return
    const name = tarText(header, 0, 100)
    const prefix = tarText(header, 345, 155)
    const type = tarText(header, 156, 1) || "0"
    const size = tarNum(header, 124, 12)
    const entry = [prefix, name].filter(Boolean).join("/")
    offset += 512
    const content = bytes.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (!entry) continue
    const target = archivePath(root, entry)
    if (type === "5") {
      await mkdir(target)
      continue
    }
    if (type === "g" || type === "x") continue
    if (type !== "0" && type !== "") throw new Error("Unsupported tar entry type: " + type)
    await mkdir(path.dirname(target))
    await fsp.writeFile(target, content)
  }
}

async function contentRoot(root: string): Promise<string> {
  const entries = (await fsp.readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.name !== ".skillhub-artifact.json",
  )
  const components = new Set(["skills", "agents", "commands"])
  if (entries.length === 1 && entries[0]!.isDirectory() && !components.has(entries[0]!.name.toLowerCase()))
    return path.join(root, entries[0]!.name)
  return root
}

async function copyLayout(source: string, target: string, kind: "skill" | "skillPkg"): Promise<void> {
  const root = await contentRoot(source)
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const names = ["skills", "agents", "commands"] as const
  const packageLayout = entries.some(
    (entry) => entry.isDirectory() && names.includes(entry.name as (typeof names)[number]),
  )
  if (kind === "skillPkg" || packageLayout) {
    let copied = false
    for (const name of names) {
      const sourcePath = path.join(root, name)
      const stat = await fsp.lstat(sourcePath).catch(() => undefined)
      if (!stat) continue
      if (!stat.isDirectory()) throw new Error("Package entry is not a directory: " + name)
      await copy(sourcePath, path.join(target, name))
      copied = true
    }
    if (kind === "skillPkg" && !copied) throw new Error("Skill package artifact has no component directories")
    return
  }
  await copy(root, path.join(target, "skills"))
}

async function unpack(source: string, target: string, kind: "skill" | "skillPkg"): Promise<void> {
  const bytes = await fsp.readFile(source)
  const unpacked = path.join(target, ".unpacked")
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    await mkdir(unpacked)
    await unzip(bytes, unpacked)
    await copyLayout(unpacked, target, kind)
    await remove(unpacked)
    return
  }
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    await mkdir(unpacked)
    await untar(zlib.gunzipSync(bytes), unpacked)
    await copyLayout(unpacked, target, kind)
    await remove(unpacked)
    return
  }
  if (kind === "skillPkg") throw new Error("Skill package payload is not an archive")
  await mkdir(path.join(target, "skills"))
  await fsp.copyFile(source, path.join(target, "skills", "SKILL.md"))
}

async function artifact(input: MaterializeInput): Promise<string> {
  if (!valid(input.digest)) {
    throw new SkillArtifactError("skill_artifact_invalid", "Skill artifact digest must be a SHA-256 value")
  }
  if (!input.versionId) {
    throw new SkillArtifactError("skill_artifact_invalid", "Skill artifact versionId is required")
  }
  const source = path.resolve(input.artifactPath)
  await checkParents(source)
  const stat = await fsp.lstat(source).catch(() => undefined)
  if (!stat) throw new SkillArtifactError("skill_artifact_invalid", "Skill artifact path does not exist")
  if (stat.isSymbolicLink()) {
    throw new SkillArtifactError("skill_artifact_invalid", "Skill artifact path may not be a symlink")
  }
  const stored = stat.isDirectory() ? await fsp.lstat(path.join(source, "payload")).catch(() => undefined) : undefined
  const payload = stored ? path.join(source, "payload") : source
  const actual = await digest(payload)
  if (norm(actual) !== norm(input.digest)) {
    throw new SkillArtifactError("skill_sha_mismatch", "Skill artifact SHA-256 mismatch", {
      expected: norm(input.digest),
      actual: norm(actual),
    })
  }
  return payload
}

async function materialized(base: string, input: MaterializeInput): Promise<MaterializeResult | undefined> {
  const existing = await fsp.lstat(base).catch(() => undefined)
  if (!existing) return undefined
  if (!existing.isDirectory()) {
    throw new SkillArtifactError("busy", "Skill materialization target already exists", { path: base })
  }
  const raw = await fsp
    .readFile(path.join(base, "manifest.json"), "utf8")
    .then((text) => JSON.parse(text) as Record<string, unknown>)
    .catch(() => null)
  const same =
    raw?.runId === input.runId &&
    raw.variantId === input.variantId &&
    raw.skillId === input.skillId &&
    raw.versionId === input.versionId &&
    norm(String(raw.digest || "")) === norm(input.digest) &&
    raw.kind === input.kind
  if (!same) throw new SkillArtifactError("busy", "Skill materialization target already exists", { path: base })
  return {
    root: base,
    skills: path.join(base, "skills"),
    agents: path.join(base, "agents"),
    commands: path.join(base, "commands"),
    manifest: raw,
  }
}

export async function materializeSkill(input: MaterializeInput): Promise<MaterializeResult> {
  const payload = await artifact(input)
  const worktree = path.resolve(input.worktree)
  const realWorktree = await fsp.realpath(worktree).catch(() => worktree)

  const base = path.join(
    worktree,
    ".testagent",
    "skillhub",
    part(input.runId, "run id"),
    part(input.variantId, "variant id"),
  )
  if (!inside(worktree, base)) throw new Error("Skill materialization path escapes worktree")
  await checkParents(path.dirname(base))
  await mkdir(path.dirname(base))
  const parent = await fsp.realpath(path.dirname(base)).catch(() => path.dirname(base))
  if (!inside(realWorktree, parent)) throw new Error("Skill materialization parent escapes worktree")

  const temp = base + ".tmp-" + crypto.randomUUID()
  await remove(temp)
  const existing = await materialized(base, input)
  if (existing) return existing
  try {
    await mkdir(temp)
    for (const name of ["skills", "agents", "commands"] as const) await mkdir(path.join(temp, name))
    const stat = await fsp.lstat(payload)
    if (stat.isDirectory()) await copyLayout(payload, temp, input.kind)
    else await unpack(payload, temp, input.kind)
    const manifest = {
      runId: input.runId,
      variantId: input.variantId,
      skillId: input.skillId,
      version: input.version ?? "",
      versionId: input.versionId,
      digest: "sha256:" + norm(input.digest),
      kind: input.kind,
      name: input.name ?? "",
      materializedAt: new Date().toISOString(),
    }
    await fsp.writeFile(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
    const occupied = await fsp.lstat(base).catch(() => undefined)
    if (occupied) throw new SkillArtifactError("busy", "Skill materialization target already exists", { path: base })
    await fsp.rename(temp, base)
    const realBase = await fsp.realpath(base)
    if (!inside(realWorktree, realBase)) {
      await remove(base)
      throw new Error("Skill materialization result escapes worktree")
    }
    return {
      root: base,
      skills: path.join(base, "skills"),
      agents: path.join(base, "agents"),
      commands: path.join(base, "commands"),
      manifest,
    }
  } catch (error) {
    await remove(temp)
    throw error
  }
}

export interface InstallSkillResult {
  skill: string
  content: string
  manifest: Record<string, unknown>
}

function skillName(value: string): string {
  const invalid = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"])
  const name = [...value]
    .map((char) => (invalid.has(char) || char.charCodeAt(0) < 32 ? "-" : char))
    .join("")
    .trim()
  if (!name || name === "." || name === "..") {
    throw new SkillArtifactError("skill_artifact_invalid", "Skill name cannot be used as a directory")
  }
  return name
}

async function skillSource(root: string, name: string): Promise<string> {
  const direct = await fsp.lstat(path.join(root, "SKILL.md")).catch(() => undefined)
  if (direct?.isFile()) return root
  const named = path.join(root, name)
  const namedFile = await fsp.lstat(path.join(named, "SKILL.md")).catch(() => undefined)
  if (namedFile?.isFile()) return named
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (dirs.length === 1) {
    const child = path.join(root, dirs[0]!.name)
    const file = await fsp.lstat(path.join(child, "SKILL.md")).catch(() => undefined)
    if (file?.isFile()) return child
  }
  throw new SkillArtifactError("skill_artifact_invalid", "Skill artifact does not contain a unique SKILL.md")
}

async function skillContent(root: string): Promise<string> {
  const raw = await fsp.readFile(path.join(root, "SKILL.md"), "utf8")
  const match = raw.match(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  const content = match ? raw.slice(match[0].length) : raw
  if (!content.trim()) {
    throw new SkillArtifactError("skill_artifact_invalid", "Installed Skill content is empty")
  }
  return content
}

/** Verify an immutable Skill artifact and atomically install it in the worktree. */
export async function installSkillVersion(input: MaterializeInput): Promise<InstallSkillResult> {
  const payload = await artifact(input)
  const worktree = path.resolve(input.worktree)
  const name = skillName(input.name || input.skillId)
  const dir = path.join(worktree, ".testagent", "skills")
  const target = path.join(dir, name)
  if (!inside(worktree, target)) {
    throw new SkillArtifactError("skill_artifact_invalid", "Skill install path escapes worktree")
  }

  const token = crypto.randomUUID()
  const stage = path.join(worktree, ".testagent", ".skillhub-install-" + token)
  const temp = target + ".tmp-" + token
  const prior = target + ".previous-" + token
  if (!inside(worktree, stage)) {
    throw new SkillArtifactError("skill_artifact_invalid", "Skill staging path escapes worktree")
  }
  await remove(stage)
  await remove(temp)
  await remove(prior)
  await mkdir(dir)
  try {
    await mkdir(stage)
    for (const item of ["skills", "agents", "commands"] as const) await mkdir(path.join(stage, item))
    const stat = await fsp.lstat(payload)
    if (stat.isDirectory()) await copyLayout(payload, stage, input.kind)
    else await unpack(payload, stage, input.kind)

    const source = await skillSource(path.join(stage, "skills"), name)
    await copy(source, temp)
    const skill = await fsp.lstat(path.join(temp, "SKILL.md")).catch(() => undefined)
    if (!skill?.isFile()) {
      throw new SkillArtifactError("skill_artifact_invalid", "Installed Skill is missing SKILL.md")
    }
    const content = await skillContent(temp)
    const manifest = {
      skillId: input.skillId,
      version: input.version || "",
      versionId: input.versionId,
      digest: "sha256:" + norm(input.digest),
      runId: input.runId,
      variantId: input.variantId,
      installedAt: new Date().toISOString(),
    }
    await fsp.writeFile(path.join(temp, ".skillhub-meta.json"), JSON.stringify(manifest, null, 2), "utf8")

    const existing = await fsp.lstat(target).catch(() => undefined)
    if (existing?.isSymbolicLink()) {
      throw new SkillArtifactError("skill_artifact_invalid", "Existing Skill path may not be a symlink")
    }
    if (existing) await fsp.rename(target, prior)
    try {
      await fsp.rename(temp, target)
      await remove(prior)
    } catch (error) {
      const backup = await fsp.lstat(prior).catch(() => undefined)
      const occupied = await fsp.lstat(target).catch(() => undefined)
      if (backup && !occupied) await fsp.rename(prior, target)
      throw error
    }
    return { skill: target, content, manifest }
  } finally {
    await remove(stage)
    await remove(temp)
  }
}
