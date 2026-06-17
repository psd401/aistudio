/**
 * Unit tests for skill allowed-tools enforcement (Issue #925, AC#6).
 * Pure intersection semantics only — DB access is exercised elsewhere.
 */

import { intersectSkillAllowedTools } from "@/lib/skills/skill-tool-enforcement"

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
