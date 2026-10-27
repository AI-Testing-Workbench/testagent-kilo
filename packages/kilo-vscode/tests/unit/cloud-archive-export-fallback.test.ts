// testagent_change - new file: verifies archive export fallback for core servers without the custom route
import { afterEach, expect, it } from "bun:test"
import { CoreArchiveApi } from "../../src/testagent/cloud/archive-api"

const hosts: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop(true)))
})

it("rebuilds an invalid archive response from the core session and message endpoints", async () => {
  const calls: string[] = []
  const info = { id: "ses_1", title: "Session", directory: "C:\\repo" }
  const messages = [{ info: { id: "msg_1", role: "user" }, parts: [{ id: "prt_1", type: "text", text: "hello" }] }]
  const host = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      calls.push(url.pathname)
      if (url.pathname.endsWith("/export")) return Response.json({ error: "archive endpoint unavailable" })
      if (url.pathname.endsWith("/message")) return Response.json(messages)
      return Response.json(info)
    },
  })
  hosts.push(host)
  const api = new CoreArchiveApi({
    connect: async () => undefined,
    config: () => ({ baseUrl: host.url.origin, password: "secret" }),
  })

  expect(await api.exportArchive("ses_1", { directory: "C:\\repo" })).toEqual({ info, messages })
  expect(calls).toEqual(["/session/ses_1/export", "/session/ses_1", "/session/ses_1/message"])
})
