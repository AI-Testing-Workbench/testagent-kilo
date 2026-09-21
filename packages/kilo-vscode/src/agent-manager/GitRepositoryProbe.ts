import * as fs from "node:fs/promises"
import * as path from "node:path"
import simpleGit, { type SimpleGit } from "simple-git"

export type RepositoryProbeKind =
  | "ready"
  | "no-repo"
  | "unborn-repo"
  | "dirty-repo"
  | "bare-repo"
  | "nested-repo"
  | "corrupt-repo"

export interface RepositoryProbeError {
  code: string
  message: string
  retryable: boolean
  detail?: Record<string, unknown>
}

export interface RepositoryProbeResult {
  kind: RepositoryProbeKind
  root: string
  top?: string
  commonDir?: string
  hasRemote: boolean
  canInitialize: boolean
  autoInit: boolean
  detail?: Record<string, unknown>
  error?: RepositoryProbeError
}

function same(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function issue(code: string, message: string, detail?: Record<string, unknown>): RepositoryProbeError {
  return { code, message, retryable: false, detail }
}

export class GitRepositoryProbe {
  private readonly root: string
  private readonly git: SimpleGit

  constructor(root: string) {
    this.root = path.resolve(root)
    this.git = simpleGit(this.root)
  }

  async probe(): Promise<RepositoryProbeResult> {
    const base = {
      root: this.root,
      hasRemote: false,
      canInitialize: false,
      autoInit: false,
    }
    const marker = await fs.lstat(path.join(this.root, ".git")).catch(() => undefined)
    const repo = await this.git.checkIsRepo().catch(() => false)
    if (!repo) {
      if (!marker) return { ...base, kind: "no-repo", canInitialize: true }
      return {
        ...base,
        kind: "corrupt-repo",
        error: issue("corrupt_repo", "The workspace contains an invalid Git repository"),
      }
    }

    const remote = (await this.git.getRemotes()).length > 0
    const common = (await this.git.revparse(["--git-common-dir"])).trim()
    const bare = (await this.git.raw(["rev-parse", "--is-bare-repository"])).trim() === "true"
    if (bare) {
      return {
        ...base,
        kind: "bare-repo",
        top: this.root,
        commonDir: path.resolve(this.root, common),
        hasRemote: remote,
        error: issue("bare_repo", "A bare Git repository cannot host Agent Manager worktrees"),
      }
    }

    const top = path.resolve((await this.git.revparse(["--show-toplevel"])).trim())
    const commonDir = path.resolve(top, common)
    if (!same(top, this.root)) {
      return {
        ...base,
        kind: "nested-repo",
        top,
        commonDir,
        hasRemote: remote,
        error: issue("nested_repo", "Open the Git repository root before creating Agent Manager worktrees", {
          workspace: this.root,
          top,
        }),
      }
    }

    const head = await this.git.revparse(["--verify", "HEAD"]).then(
      () => true,
      () => false,
    )
    if (!head) {
      return {
        ...base,
        kind: "unborn-repo",
        top,
        commonDir,
        hasRemote: remote,
        canInitialize: true,
        error: issue("no_initial_commit", "The Git repository has no initial commit"),
      }
    }

    const status = await this.git.raw(["status", "--short"])
    if (status.trim()) {
      return {
        ...base,
        kind: "dirty-repo",
        top,
        commonDir,
        hasRemote: remote,
        detail: { status },
      }
    }
    return { ...base, kind: "ready", top, commonDir, hasRemote: remote }
  }

  async initialize(): Promise<RepositoryProbeResult> {
    const current = await this.probe()
    if (current.kind === "ready" || current.kind === "dirty-repo") return current
    if (!current.canInitialize) throw new Error(current.error?.message || "The workspace cannot be initialized")

    if (current.kind === "no-repo") await this.git.init()
    const info = path.join(this.root, ".git", "info")
    await fs.mkdir(info, { recursive: true })
    const exclude = path.join(info, "exclude")
    const existing = await fs.readFile(exclude, "utf8").catch(() => "")
    const entries = [
      ".testagent/worktrees/",
      ".testagent/agent-manager.json",
      ".testagent/.skillhub-install-*",
      ".testagent/setup-script",
      ".testagent/setup-script.sh",
      ".testagent/setup-script.ps1",
      ".testagent/setup-script.cmd",
      ".testagent/setup-script.bat",
      ".kilocode/worktrees/",
      ".kilocode/agent-manager.json",
      ".kilocode/setup-script",
      ".kilocode/setup-script.sh",
      ".kilocode/setup-script.ps1",
    ]
    const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry))
    if (missing.length > 0) {
      const pad = existing && !existing.endsWith("\n") ? "\n" : ""
      await fs.appendFile(exclude, pad + "\n# TestAgent local runtime\n" + missing.join("\n") + "\n", "utf8")
    }

    await this.git.raw(["add", "-A"])
    await this.git.raw([
      "-c",
      "user.name=TestAgent Agent Manager",
      "-c",
      "user.email=agent-manager@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "Initialize repository for Agent Manager",
    ])
    const result = await this.probe()
    if (result.kind !== "ready") throw new Error("Git initialization did not produce a clean local repository")
    return { ...result, autoInit: true }
  }
}
