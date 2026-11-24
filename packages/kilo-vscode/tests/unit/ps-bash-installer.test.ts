import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fetchZip } from "../../src/services/cli-backend/ps-bash-installer"

const roots: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function setup(response: (req: Request) => Response) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps-bash-download-"))
  roots.push(root)
  const server = Bun.serve({ port: 0, fetch: response })
  servers.push(server)
  return { zip: path.join(root, "shell.zip"), url: server.url.href }
}

test("下载重定向后的文件并保留二进制内容", async () => {
  const body = new Uint8Array([80, 75, 3, 4, 0, 255, 128])
  const ctx = await setup((req) =>
    new URL(req.url).pathname === "/archive"
      ? new Response(body)
      : new Response(null, { status: 302, headers: { location: "/archive" } }),
  )
  await fetchZip(ctx.zip, ctx.url)
  expect(new Uint8Array(await fs.readFile(ctx.zip))).toEqual(body)
})

test("HTTP 错误显示状态和地址且不写入压缩包", async () => {
  const ctx = await setup(() => new Response("missing", { status: 404 }))
  await expect(fetchZip(ctx.zip, ctx.url)).rejects.toThrow(`下载返回 HTTP 404 Not Found；下载地址：${ctx.url}`)
  expect(await fs.exists(ctx.zip)).toBe(false)
})

test("空响应显示具体原因且不写入压缩包", async () => {
  const ctx = await setup(() => new Response(null))
  await expect(fetchZip(ctx.zip, ctx.url)).rejects.toThrow("下载内容为空")
  expect(await fs.exists(ctx.zip)).toBe(false)
})

test("文件写入失败不会触发网络回退", async () => {
  const ctx = await setup(() => new Response("archive"))
  await expect(fetchZip(path.join(ctx.zip, "missing.zip"), ctx.url)).rejects.toThrow("ENOENT")
})
