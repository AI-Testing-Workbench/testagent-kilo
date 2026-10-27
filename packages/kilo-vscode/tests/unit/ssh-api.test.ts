// testagent_change - new file: verify the isolated Remote SSH extension version contract
import { expect, it } from "bun:test"
import { isRemoteSshOutdated, remoteSshVersionSupported, RemoteSshApiError } from "../../src/testagent/cloud/ssh-api"

it("requires the supported 1.2.0 Remote SSH API baseline", () => {
  expect(remoteSshVersionSupported("1.1.1")).toBe(false)
  expect(remoteSshVersionSupported("1.2.0")).toBe(true)
  expect(remoteSshVersionSupported("1.2.1")).toBe(true)
  expect(remoteSshVersionSupported("2.0.0")).toBe(true)
  expect(remoteSshVersionSupported("1.2.0-rc.1")).toBe(false)
  expect(remoteSshVersionSupported("unknown")).toBe(false)
})

it("recognizes the old-version error through API wrappers", () => {
  const err = new RemoteSshApiError("plugin too old", { version: "1.1.1" }, "outdated")
  expect(isRemoteSshOutdated({ detail: { cause: err } })).toBe(true)
  expect(isRemoteSshOutdated(new RemoteSshApiError("not installed"))).toBe(false)
})
