// testagent_change - new file: exercise repository verification and fast-forward behavior with real local Git repos
import { afterEach, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import simpleGit, { type SimpleGit } from "simple-git"
import { pullImportedRepository } from "../../src/testagent/cloud/import-sync"
import type { ContainerStatusResult } from "../../src/testagent/cloud/ssh-api"

const roots: string[] = []
const url = "https://github.com/alice/repo.git"

async function repo(): Promise<{ root: string; bare: string }> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-import-sync-"))
  roots.push(temp)
  const root = path.join(temp, "work")
  const bare = path.join(temp, "repo.git")
  await fs.mkdir(root)
  await simpleGit().raw(["init", "--bare", "--initial-branch=main", bare])
  const git = simpleGit(root)
  await git.raw(["init", "-b", "main"])
  await fs.writeFile(path.join(root, "README.md"), "base\n")
  await git.add("README.md")
  await commit(git, "base")
  await git.addRemote("origin", bare)
  await git.push("origin", "main")
  return { root, bare }
}

async function commit(git: SimpleGit, name: string): Promise<void> {
  await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", name])
}

async function advance(bare: string): Promise<string> {
  const dir = path.join(path.dirname(bare), "advance")
  await simpleGit().raw(["clone", "--branch", "main", bare, dir])
  const git = simpleGit(dir)
  await fs.writeFile(path.join(dir, "README.md"), "remote\n")
  await git.add("README.md")
  await commit(git, "remote")
  await git.push("origin", "main")
  return dir
}

async function rewrite(root: string, bare: string): Promise<void> {
  const git = simpleGit(root)
  await git.raw(["remote", "set-url", "origin", url])
  await git.raw(["config", "--local", `url.${pathToFileURL(bare).href}.insteadOf`, url])
}

function state(branch: string | null = "main"): ContainerStatusResult {
  return {
    service_id: "service-1",
    status: "running",
    gitee_url: "https://github.com",
    gitee_user: "alice",
    gitee_repository: "repo",
    gitee_branch: branch,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

it("fast-forwards a clean matching local branch to its service branch", async () => {
  const { root, bare } = await repo()
  await advance(bare)
  await rewrite(root, bare)

  expect(await pullImportedRepository(root, state())).toBeUndefined()
  expect(await simpleGit(root).show(["HEAD:README.md"])).toBe("remote\n")
}, 30_000)

it("warns for address and branch mismatches without fetching", async () => {
  const { root } = await repo()
  await simpleGit(root).raw(["remote", "set-url", "origin", "https://github.com/bob/other.git"])
  const head = await simpleGit(root).revparse("HEAD")

  const warning = await pullImportedRepository(root, state("release"))

  expect(warning).toContain("地址")
  expect(warning).toContain("分支")
  expect(await simpleGit(root).revparse("HEAD")).toBe(head)
}, 30_000)

it("warns when the service branch is null", async () => {
  const { root, bare } = await repo()
  await rewrite(root, bare)

  const warning = await pullImportedRepository(root, state(null))

  expect(warning).toContain("未返回有效的码云分支")
}, 30_000)

it("does not change a divergent local branch", async () => {
  const { root, bare } = await repo()
  await fs.writeFile(path.join(root, "README.md"), "local\n")
  await simpleGit(root).add("README.md")
  await commit(simpleGit(root), "local")
  await advance(bare)
  await rewrite(root, bare)
  const head = await simpleGit(root).revparse("HEAD")

  const warning = await pullImportedRepository(root, state())

  expect(warning).toContain("无法快进")
  expect(await simpleGit(root).revparse("HEAD")).toBe(head)
  expect(await simpleGit(root).show(["HEAD:README.md"])).toBe("local\n")
}, 30_000)

it("does not fetch into a dirty local worktree", async () => {
  const { root, bare } = await repo()
  await advance(bare)
  await rewrite(root, bare)
  await fs.writeFile(path.join(root, "untracked.txt"), "local change\n")
  const head = await simpleGit(root).revparse("HEAD")

  const warning = await pullImportedRepository(root, state())

  expect(warning).toContain("未提交改动")
  expect(await simpleGit(root).revparse("HEAD")).toBe(head)
  expect(await fs.readFile(path.join(root, "untracked.txt"), "utf8")).toBe("local change\n")
}, 30_000)
