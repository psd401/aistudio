/**
 * Unit tests for skill allowed-tools enforcement (Issue #925, AC#6).
 * Covers the pure intersection semantics and the security-relevant DB accessor
 * (`getApprovedSkillAllowedTools`), whose `null` return is the "do not loosen"
 * signal for an unknown/unapproved skill id.
 */

// Mock the DB layer so getApprovedSkillAllowedTools can be driven by the rows
// executeQuery resolves to. The Drizzle query builder callback is never run.
const executeQueryMock = jest.fn()
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}))
jest.mock("@/lib/db/schema/tables/agent-skills", () => ({
  psdAgentSkills: {},
}))
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}))

import {
  intersectSkillAllowedTools,
  getApprovedSkillAllowedTools,
} from "@/lib/skills/skill-tool-enforcement"

describe("intersectSkillAllowedTools", () => {
  it("returns all available tools when the skill pins nothing", () => {
    expect(
      intersectSkillAllowedTools(["webSearch", "codeInterpreter"], [])
    ).toEqual(["webSearch", "codeInterpreter"])
  })

  it("returns a copy, not the same array reference, for the no-pin case", () => {
    const available = ["a", "b"]
    const result = intersectSkillAllowedTools(available, [])
    expect(result).toEqual(available)
    expect(result).not.toBe(available)
  })

  it("restricts to the overlap when the skill pins tools", () => {
    expect(
      intersectSkillAllowedTools(
        ["webSearch", "codeInterpreter", "imageGen"],
        ["webSearch", "imageGen"]
      )
    ).toEqual(["webSearch", "imageGen"])
  })

  it("preserves the order of the available list, not the pin list", () => {
    expect(
      intersectSkillAllowedTools(
        ["a", "b", "c"],
        ["c", "a"]
      )
    ).toEqual(["a", "c"])
  })

  it("returns empty when the pin and available sets do not overlap", () => {
    expect(
      intersectSkillAllowedTools(["a", "b"], ["x", "y"])
    ).toEqual([])
  })

  it("drops available tools the skill does not pin", () => {
    expect(
      intersectSkillAllowedTools(["a", "b", "c"], ["b"])
    ).toEqual(["b"])
  })
})

describe("getApprovedSkillAllowedTools (DB path)", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
  })

  it("returns null when the skill id is unknown or not approved", async () => {
    // No matching row (draft/rejected skill, or bogus id).
    executeQueryMock.mockResolvedValue([])
    await expect(
      getApprovedSkillAllowedTools("00000000-0000-0000-0000-000000000000")
    ).resolves.toBeNull()
  })

  it("returns the skill's allowed-tools when approved", async () => {
    executeQueryMock.mockResolvedValue([
      { allowedTools: ["webSearch", "imageGen"] },
    ])
    await expect(getApprovedSkillAllowedTools("skill-id")).resolves.toEqual([
      "webSearch",
      "imageGen",
    ])
  })

  it("returns an empty array (no pin) when allowedTools is null in the row", async () => {
    // An approved skill that pins nothing stores null/non-array; the accessor
    // normalizes to [] so callers keep all available tools (no pin), NOT null.
    executeQueryMock.mockResolvedValue([{ allowedTools: null }])
    await expect(getApprovedSkillAllowedTools("skill-id")).resolves.toEqual([])
  })
})
