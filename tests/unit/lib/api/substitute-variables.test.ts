/**
 * @jest-environment node
 *
 * Variable substitution must not leak Object.prototype members into prompts
 * (REV-COR-517): an unknown variable naming an inherited member (${constructor},
 * ${toString}, …) is left as a literal, while legitimately-supplied inputs still
 * substitute.
 */
import { substituteVariables } from "@/lib/api/assistant-execution-service"

describe("substituteVariables prototype safety (REV-COR-517)", () => {
  const NO_PROMPTS: never[] = []

  it("leaves ${constructor} / ${toString} / ${hasOwnProperty} as literals when unsupplied", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const out = substituteVariables(`\${${name}}`, {}, new Map(), {}, NO_PROMPTS, 0)
      expect(out).toBe(`\${${name}}`)
    }
  })

  it("still substitutes a real supplied input", () => {
    expect(substituteVariables("${topic}", { topic: "cats" }, new Map(), {}, NO_PROMPTS, 0)).toBe(
      "cats"
    )
  })

  it("substitutes an own-property input even if its name shadows a prototype member", () => {
    // A caller who *does* supply { toString: "x" } gets it — own property wins.
    expect(
      substituteVariables("${toString}", { toString: "x" }, new Map(), {}, NO_PROMPTS, 0)
    ).toBe("x")
  })
})
