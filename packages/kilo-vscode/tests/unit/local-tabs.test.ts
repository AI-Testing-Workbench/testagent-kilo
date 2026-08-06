import { describe, it, expect } from "bun:test"
import {
  MAX_TABS,
  PENDING_TAB_PREFIX,
  activatePendingTab,
  capTabs,
  reuseOrOpenSessionTab,
  type LocalTabState,
} from "../../webview-ui/src/utils/local-tabs"

const pending = () => `${PENDING_TAB_PREFIX}draft`

describe("reuseOrOpenSessionTab", () => {
  it("replaces the active pending tab when opening a session", () => {
    const state: LocalTabState = { ids: [pending()], active: pending() }
    expect(reuseOrOpenSessionTab(state, "s1")).toEqual({ ids: ["s1"], active: "s1" })
  })

  it("replaces the active pending tab among other tabs", () => {
    const state: LocalTabState = { ids: ["s1", pending()], active: pending() }
    const next = reuseOrOpenSessionTab(state, "s2")
    expect(next.ids).toEqual(["s1", "s2"])
    expect(next.active).toBe("s2")
  })

  it("opens a new tab when the active tab is a real session", () => {
    const state: LocalTabState = { ids: ["s1"], active: "s1" }
    const next = reuseOrOpenSessionTab(state, "s2")
    expect(next.ids).toEqual(["s1", "s2"])
    expect(next.active).toBe("s2")
  })

  it("focuses an already-open session instead of duplicating it", () => {
    const state: LocalTabState = { ids: [pending(), "s2"], active: pending() }
    const next = reuseOrOpenSessionTab(state, "s2")
    expect(next.ids).toEqual(["s2"])
    expect(next.active).toBe("s2")
  })

  it("does not remove other pending tabs", () => {
    const state: LocalTabState = { ids: ["s1", pending()], active: "s1" }
    const next = reuseOrOpenSessionTab(state, "s2")
    expect(next.ids).toEqual(["s1", pending(), "s2"])
    expect(next.active).toBe("s2")
  })

  it("opens a new tab when there is no active tab", () => {
    const state: LocalTabState = { ids: ["s1"] }
    const next = reuseOrOpenSessionTab(state, "s2")
    expect(next.ids).toEqual(["s1", "s2"])
    expect(next.active).toBe("s2")
  })
})

describe("activatePendingTab", () => {
  it("activates an existing pending tab", () => {
    const state: LocalTabState = { ids: ["s1", pending()], active: "s1" }
    const next = activatePendingTab(state)
    expect(next.ids).toEqual(["s1", pending()])
    expect(next.active).toBe(pending())
  })

  it("returns the same state when the pending tab is already active", () => {
    const state: LocalTabState = { ids: [pending(), "s1"], active: pending() }
    expect(activatePendingTab(state)).toBe(state)
  })

  it("returns the same state when no pending tab exists", () => {
    const state: LocalTabState = { ids: ["s1", "s2"], active: "s1" }
    expect(activatePendingTab(state)).toBe(state)
  })
})

describe("capTabs", () => {
  const tabs = Array.from({ length: MAX_TABS + 2 }, (_, i) => `s${i + 1}`)

  it("leaves states within the limit untouched", () => {
    const state: LocalTabState = { ids: ["s1", "s2"], active: "s2" }
    expect(capTabs(state)).toBe(state)
  })

  it("trims to MAX_TABS keeping the active tab first", () => {
    const state: LocalTabState = { ids: tabs, active: "s6" }
    const next = capTabs(state)
    expect(next.ids).toHaveLength(MAX_TABS)
    expect(next.ids[0]).toBe("s6")
    expect(next.active).toBe("s6")
  })

  it("keeps the first tabs when there is no active tab", () => {
    const state: LocalTabState = { ids: tabs }
    const next = capTabs(state)
    expect(next.ids).toEqual(tabs.slice(0, MAX_TABS))
    expect(next.active).toBe("s1")
  })
})
