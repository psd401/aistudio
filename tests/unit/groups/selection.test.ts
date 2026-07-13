/**
 * Unit tests for the app-side group selection + normalization (Epic #1202,
 * Phase 0 / #1203). Runs in the standard jest suite (the DoD gate). The sync
 * Lambda's reconciliation/fail-safety core has its own bun tests
 * (infra/lambdas/group-sync/sync.test.ts) since it is an isolated bundle.
 *
 * Covers the acceptance criteria at the app layer:
 *   - selection resolves hand-picked AND prefix-matched groups (both modes)
 *   - a hand-pick wins over a prefix match on a tie
 *   - emails compare case-insensitively (lowercased on every comparison)
 */

import { normalizeEmail, normalizePrefix } from "@/lib/groups/normalize"
import { resolveSelection, type SelectionRuleInput } from "@/lib/groups/selection"

describe("normalizeEmail / normalizePrefix", () => {
  it("lowercases and trims, returning '' for nullish", () => {
    expect(normalizeEmail("  Alice@PSD401.net ")).toBe("alice@psd401.net")
    expect(normalizeEmail(null)).toBe("")
    expect(normalizeEmail(undefined)).toBe("")
    expect(normalizePrefix("  STAFF- ")).toBe("staff-")
  })
})

describe("resolveSelection", () => {
  const groups = [
    { groupEmail: "Staff-All@psd401.net" },
    { groupEmail: "staff-hs@psd401.net" },
    { groupEmail: "board@psd401.net" },
    { groupEmail: "random@psd401.net" },
  ]

  it("resolves a hand-picked group case-insensitively (source manual)", () => {
    const rules: SelectionRuleInput[] = [
      { ruleType: "pick", value: "BOARD@psd401.net", isActive: true },
    ]
    const resolved = resolveSelection(rules, groups)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].group.groupEmail).toBe("board@psd401.net")
    expect(resolved[0].source).toBe("manual")
  })

  it("resolves prefix-matched groups (source prefix), matching mixed case", () => {
    const rules: SelectionRuleInput[] = [
      { ruleType: "prefix", value: "Staff-", isActive: true },
    ]
    const resolved = resolveSelection(rules, groups)
    // The resolver preserves each group's original casing; matching is what is
    // case-insensitive, so normalize before comparing.
    const emails = resolved.map((r) => normalizeEmail(r.group.groupEmail)).sort()
    expect(emails).toEqual(["staff-all@psd401.net", "staff-hs@psd401.net"])
    expect(resolved.every((r) => r.source === "prefix")).toBe(true)
  })

  it("applies both modes at once and lets a pick win a tie", () => {
    const rules: SelectionRuleInput[] = [
      { ruleType: "prefix", value: "staff-", isActive: true },
      { ruleType: "pick", value: "staff-hs@psd401.net", isActive: true },
      { ruleType: "pick", value: "board@psd401.net", isActive: true },
    ]
    const resolved = resolveSelection(rules, groups)
    const byEmail = new Map(resolved.map((r) => [normalizeEmail(r.group.groupEmail), r.source]))
    expect(byEmail.get("staff-hs@psd401.net")).toBe("manual") // pick wins the tie
    expect(byEmail.get("staff-all@psd401.net")).toBe("prefix")
    expect(byEmail.get("board@psd401.net")).toBe("manual")
    expect(byEmail.has("random@psd401.net")).toBe(false)
  })

  it("ignores inactive rules and empty prefixes (no select-all footgun)", () => {
    const rules: SelectionRuleInput[] = [
      { ruleType: "pick", value: "board@psd401.net", isActive: false },
      { ruleType: "prefix", value: "   ", isActive: true },
    ]
    expect(resolveSelection(rules, groups)).toEqual([])
  })
})
