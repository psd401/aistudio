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
  getApprovedSkillSession,
  parseSkillAllowedTools,
  filterConnectorToolsByPin,
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

  // Issue #927: @version pins match on the version-stripped base name (the
  // client-supplied available names carry no version).
  it("matches a versioned pin on the base name", () => {
    expect(
      intersectSkillAllowedTools(
        ["documents.create", "web.fetch"],
        ["documents.create@v1"]
      )
    ).toEqual(["documents.create"])
  })

  it("mixes versioned and unversioned pins", () => {
    expect(
      intersectSkillAllowedTools(
        ["a", "b", "c"],
        ["a@v2", "c"]
      )
    ).toEqual(["a", "c"])
  })

  it("a malformed version pin fails closed (matches nothing)", () => {
    // `a@2` is malformed -> kept as the literal name `a@2`, which no real tool
    // name equals, so it is excluded rather than silently widening to `a`.
    expect(intersectSkillAllowedTools(["a", "b"], ["a@2"])).toEqual([])
  })
})

describe("parseSkillAllowedTools (#927)", () => {
  it("splits identifier@version into name + version", () => {
    expect(parseSkillAllowedTools(["documents.create@v2"])).toEqual([
      { name: "documents.create", version: "v2", raw: "documents.create@v2" },
    ])
  })

  it("treats an unversioned entry as version null", () => {
    expect(parseSkillAllowedTools(["web.fetch"])).toEqual([
      { name: "web.fetch", version: null, raw: "web.fetch" },
    ])
  })

  it("keeps a malformed pin as a literal name (fail-closed)", () => {
    expect(parseSkillAllowedTools(["tool@latest"])).toEqual([
      { name: "tool@latest", version: null, raw: "tool@latest" },
    ])
  })

  it("drops blank entries and trims", () => {
    expect(parseSkillAllowedTools(["", "  a@v1  ", "   "])).toEqual([
      { name: "a", version: "v1", raw: "a@v1" },
    ])
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
    // The underlying getApprovedSkillSession query now also selects name/s3Key.
    executeQueryMock.mockResolvedValue([
      {
        name: "weather-helper",
        allowedTools: ["webSearch", "imageGen"],
        s3Key: "skills/shared/weather-helper/",
      },
    ])
    await expect(getApprovedSkillAllowedTools("skill-id")).resolves.toEqual([
      "webSearch",
      "imageGen",
    ])
  })

  it("returns an empty array (no pin) when allowedTools is null in the row", async () => {
    // An approved skill that pins nothing stores null/non-array; the accessor
    // normalizes to [] so callers keep all available tools (no pin), NOT null.
    executeQueryMock.mockResolvedValue([
      { name: "no-pin", allowedTools: null, s3Key: "skills/shared/no-pin/" },
    ])
    await expect(getApprovedSkillAllowedTools("skill-id")).resolves.toEqual([])
  })
})

describe("getApprovedSkillSession (epic #922 completion audit)", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
  })

  it("returns name, allowedTools, and s3Key for an approved skill", async () => {
    executeQueryMock.mockResolvedValue([
      {
        name: "weather-helper",
        allowedTools: ["documents.create@v1"],
        s3Key: "skills/shared/weather-helper/",
      },
    ])
    await expect(getApprovedSkillSession("skill-id")).resolves.toEqual({
      name: "weather-helper",
      allowedTools: ["documents.create@v1"],
      s3Key: "skills/shared/weather-helper/",
    })
  })

  it("returns null for an unknown/unapproved skill id", async () => {
    executeQueryMock.mockResolvedValue([])
    await expect(
      getApprovedSkillSession("00000000-0000-0000-0000-000000000000")
    ).resolves.toBeNull()
  })

  it("normalizes a null allowedTools column to an empty pin", async () => {
    executeQueryMock.mockResolvedValue([
      { name: "no-pin", allowedTools: null, s3Key: "skills/shared/no-pin/" },
    ])
    await expect(getApprovedSkillSession("skill-id")).resolves.toEqual({
      name: "no-pin",
      allowedTools: [],
      s3Key: "skills/shared/no-pin/",
    })
  })
})

describe("filterConnectorToolsByPin (#925 AC#6 — epic #922 completion audit)", () => {
  function makeResults() {
    const close = jest.fn()
    return [
      {
        serverId: "srv-1",
        tools: {
          "documents.create": { description: "create a doc" },
          "external.rocket": { description: "launch" },
        },
        close,
      },
    ]
  }

  it("returns the results unchanged when the skill pins nothing", () => {
    const results = makeResults()
    const out = filterConnectorToolsByPin(results, [])
    expect(out).toEqual(results)
    expect(Object.keys(out[0].tools)).toEqual([
      "documents.create",
      "external.rocket",
    ])
  })

  it("keeps only connector tools whose name matches a version-stripped pin", () => {
    const results = makeResults()
    const out = filterConnectorToolsByPin(results, ["documents.create@v1"])
    expect(Object.keys(out[0].tools)).toEqual(["documents.create"])
  })

  it("drops every connector tool when no pin matches", () => {
    const results = makeResults()
    const out = filterConnectorToolsByPin(results, ["some.other.tool"])
    expect(Object.keys(out[0].tools)).toEqual([])
  })

  it("returns NEW objects and never mutates the originals' tools", () => {
    const results = makeResults()
    const out = filterConnectorToolsByPin(results, ["documents.create"])
    expect(out[0]).not.toBe(results[0])
    expect(out[0].tools).not.toBe(results[0].tools)
    // Original tool set untouched (its close handle must still clean up both).
    expect(Object.keys(results[0].tools)).toEqual([
      "documents.create",
      "external.rocket",
    ])
  })

  it("preserves non-tools properties (serverId, close) via spread", () => {
    const results = makeResults()
    const out = filterConnectorToolsByPin(results, ["documents.create"])
    expect(out[0].serverId).toBe("srv-1")
    expect(out[0].close).toBe(results[0].close)
  })
})
