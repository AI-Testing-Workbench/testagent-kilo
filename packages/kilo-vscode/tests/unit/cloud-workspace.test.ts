// testagent_change - new file
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import simpleGit from "simple-git"
import {
  type CloudInfo,
  type CloudPaths,
  cloudPaths,
  ensureCloudWorkspace,
  readCloudInfo,
  resolveGitRoot,
  writeCloudInfo,
  CloudWorkspaceError,
} from "../../src/testagent/cloud/workspace"

const roots: string[] = []

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-cloud-"))
  roots.push(root)
  const git = simpleGit(root)
  await git.init()
  await git.addRemote("origin", "https://github.com/test/repo.git")
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("码云仓库云端工作区状态", () => {
  it("只在本地码云仓库根目录创建云端路径和空状态文件", async () => {
    const root = await repo()
    const sub = path.join(root, "nested")
    await fs.mkdir(sub, { recursive: true })

    const workspace = await ensureCloudWorkspace(sub)
    const paths: CloudPaths = cloudPaths(root)

    expect(workspace.root).toBe(await fs.realpath(root))
    expect(workspace.cloud).toBe(paths.cloud)
    const state: CloudInfo = workspace.state
    expect(state).toEqual({ serviceIds: [] })
    expect(await fs.readFile(paths.info, "utf8")).toBe(`${JSON.stringify({ serviceIds: [] }, null, 2)}\n`)
    expect(await fs.readFile(path.join(paths.cloud, ".gitignore"), "utf8")).toBe("*\n")
    expect(await fs.stat(paths.import).then((stat) => stat.isDirectory())).toBe(true)
    expect(await fs.stat(paths.export).then((stat) => stat.isDirectory())).toBe(true)
    expect(
      [paths.cloud, paths.import, paths.export, paths.info, paths.lock].every((file) =>
        path.relative(root, file).startsWith(".testagent"),
      ),
    ).toBe(true)
    expect((await simpleGit(root).status()).files).toHaveLength(0)
  }, 15_000)

  it("不在本地码云仓库工作树之外创建云端文件", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-nogit-"))
    roots.push(root)

    await expect(ensureCloudWorkspace(root)).rejects.toMatchObject<Partial<CloudWorkspaceError>>({ code: "not_git" })
    expect(await fs.stat(path.join(root, ".testagent")).catch(() => undefined)).toBeUndefined()
  })

  it("拒绝可能暴露运行时文件的云端忽略规则", async () => {
    const root = await repo()
    const file = path.join(cloudPaths(root).cloud, ".gitignore")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "*\n!important.json\n")

    await expect(ensureCloudWorkspace(root)).rejects.toMatchObject<Partial<CloudWorkspaceError>>({
      code: "invalid_ignore",
    })
    expect(await fs.readFile(file, "utf8")).toBe("*\n!important.json\n")
    expect(await fs.stat(cloudPaths(root).info).catch(() => undefined)).toBeUndefined()
  }, 15_000)

  it("从子目录解析本地码云仓库根目录", async () => {
    const root = await repo()
    const sub = path.join(root, "src", "child")
    await fs.mkdir(sub, { recursive: true })

    expect(await resolveGitRoot(sub)).toBe(await fs.realpath(root))
  })

  it("去重 service ID 并保留有效绑定", async () => {
    const root = await repo()
    const file = cloudPaths(root).info
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ serviceIds: ["service-a", "service-a"] }))

    expect(await readCloudInfo(root)).toEqual({ serviceIds: ["service-a"] })
  })

  it("不把损坏 JSON 或无效结构当作空绑定", async () => {
    const root = await repo()
    const file = cloudPaths(root).info
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{")

    await expect(readCloudInfo(root)).rejects.toMatchObject<Partial<CloudWorkspaceError>>({ code: "invalid_info" })
    expect(await fs.readFile(file, "utf8")).toBe("{")
    await fs.writeFile(file, JSON.stringify({ serviceIds: [4] }))
    await expect(readCloudInfo(root)).rejects.toMatchObject<Partial<CloudWorkspaceError>>({ code: "invalid_info" })
  })

  it("拒绝绑定多个不同的 service ID", async () => {
    const root = await repo()
    const file = cloudPaths(root).info
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ serviceIds: ["service-a", "service-b"] }))

    await expect(readCloudInfo(root)).rejects.toMatchObject<Partial<CloudWorkspaceError>>({ code: "multiple_services" })
  })

  it("原子写入有效状态并拒绝超过上限的更新", async () => {
    const root = await repo()

    expect(await writeCloudInfo(root, { serviceIds: ["service-a", "service-a"] })).toEqual({
      serviceIds: ["service-a"],
    })
    expect(await readCloudInfo(root)).toEqual({ serviceIds: ["service-a"] })
    expect(await fs.readFile(path.join(cloudPaths(root).cloud, ".gitignore"), "utf8")).toBe("*\n")
    await expect(writeCloudInfo(root, { serviceIds: ["service-a", "service-b"] })).rejects.toMatchObject<
      Partial<CloudWorkspaceError>
    >({ code: "multiple_services" })
    expect((await fs.readdir(cloudPaths(root).cloud)).some((file) => file.endsWith(".tmp"))).toBe(false)
  })
})
