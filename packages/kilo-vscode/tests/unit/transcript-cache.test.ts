import { describe, expect, it } from "bun:test"
import {
  getMeasurement,
  getScroll,
  layoutFingerprint,
  resolveAnchor,
  rowFingerprint,
  setMeasurement,
  setScroll,
} from "../../webview-ui/src/components/chat/transcript-cache"

const metrics = { width: 380, ratio: 2, font: "sans", size: "13px", line: "1.5" }

describe("rowFingerprint", () => {
  it("differs when any key differs and matches for identical lists", () => {
    expect(rowFingerprint(["a:user", "b:user"])).toBe(rowFingerprint(["a:user", "b:user"]))
    expect(rowFingerprint(["a:user"])).not.toBe(rowFingerprint(["a:user", "b:user"]))
  })
})

describe("layoutFingerprint", () => {
  it("changes with width or font", () => {
    expect(layoutFingerprint(metrics)).toBe(layoutFingerprint({ ...metrics }))
    expect(layoutFingerprint(metrics)).not.toBe(layoutFingerprint({ ...metrics, width: 400 }))
    expect(layoutFingerprint(metrics)).not.toBe(layoutFingerprint({ ...metrics, font: "serif" }))
  })
})

describe("measurements", () => {
  it("returns the cache only while keys and layout fingerprints match", () => {
    const keys = rowFingerprint(["r1", "r2"])
    const layout = layoutFingerprint(metrics)
    setMeasurement("s", keys, layout, [] as never)
    expect(getMeasurement("s", keys, layout)).toEqual([])
    expect(getMeasurement("s", rowFingerprint(["r1"]), layout)).toBeUndefined()
    expect(getMeasurement("s", keys, layoutFingerprint({ ...metrics, width: 1 }))).toBeUndefined()
    expect(getMeasurement("other", keys, layout)).toBeUndefined()
  })

  it("drops the entry after a fingerprint miss", () => {
    const keys = rowFingerprint(["r1"])
    setMeasurement("s2", keys, "L", [1] as never)
    expect(getMeasurement("s2", rowFingerprint([]), "L")).toBeUndefined()
    expect(getMeasurement("s2", keys, "L")).toBeUndefined()
  })
})

describe("scrolls", () => {
  it("stores bottom and anchor states per session", () => {
    setScroll("s", { type: "bottom" })
    expect(getScroll("s")).toEqual({ type: "bottom" })
    setScroll("s", { type: "anchor", key: "k2", offset: 12 })
    expect(getScroll("s")).toEqual({ type: "anchor", key: "k2", offset: 12 })
    expect(getScroll("missing")).toBeUndefined()
  })
})

describe("resolveAnchor", () => {
  it("maps an anchor key to its current index", () => {
    const state = { type: "anchor", key: "k2", offset: 5 } as const
    expect(resolveAnchor(state, ["k1", "k2", "k3"])).toEqual({ index: 1, offset: 5 })
  })

  it("returns undefined for bottom states and vanished keys", () => {
    expect(resolveAnchor({ type: "bottom" }, ["k1"])).toBeUndefined()
    expect(resolveAnchor(undefined, ["k1"])).toBeUndefined()
    expect(resolveAnchor({ type: "anchor", key: "gone", offset: 1 }, ["k1"])).toBeUndefined()
  })
})
