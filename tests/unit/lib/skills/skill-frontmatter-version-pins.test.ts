import { describe, it, expect } from "@jest/globals"
import { findMalformedToolVersionPins } from "@/infra/lambdas/agent-skill-builder/frontmatter-tools"

describe("findMalformedToolVersionPins (#927)", () => {
  it("returns nothing when there are no pins", () => {
    const fm = "name: my-skill\nsummary: does a thing\n"
    expect(findMalformedToolVersionPins(fm)).toEqual([])
  })

  it("accepts well-formed inline @version pins", () => {
    const fm = "name: s\nallowed-tools: documents.create@v2, web.fetch@v1, nexus.chat\n"
    expect(findMalformedToolVersionPins(fm)).toEqual([])
  })

  it("flags a bare-integer version (missing v) inline", () => {
    const fm = "name: s\nallowed-tools: documents.create@2, web.fetch\n"
    expect(findMalformedToolVersionPins(fm)).toEqual(["documents.create@2"])
  })

  it("flags a non-numeric version inline", () => {
    const fm = "allowed-tools: a@latest\n"
    expect(findMalformedToolVersionPins(fm)).toEqual(["a@latest"])
  })

  it("flags a double-@ pin", () => {
    const fm = "allowed-tools: a@v1@v2\n"
    expect(findMalformedToolVersionPins(fm)).toEqual(["a@v1@v2"])
  })

  it("parses the YAML list form", () => {
    const fm = [
      "name: s",
      "allowed-tools:",
      "  - documents.create@v2",
      "  - web.fetch@bad",
      "  - nexus.chat",
      "summary: x",
    ].join("\n")
    expect(findMalformedToolVersionPins(fm)).toEqual(["web.fetch@bad"])
  })

  it("dedupes repeated malformed entries", () => {
    const fm = "allowed-tools: a@2, a@2, b@3\n"
    expect(findMalformedToolVersionPins(fm)).toEqual(["a@2", "b@3"])
  })

  it("ignores unversioned entries entirely", () => {
    const fm = "allowed-tools: a, b, c\n"
    expect(findMalformedToolVersionPins(fm)).toEqual([])
  })
})
