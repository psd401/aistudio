/**
 * Unit tests for the skill tool executor (Issue #925, AC#5 — epic #922
 * completion audit). Covers the pure `skill:{id}` handlerRef parser and the
 * fail-closed loading semantics of `executeSkillTool` (approved-only lookup,
 * unreadable-SKILL.md error, and the success path returning the document).
 */

// Mock the DB layer so executeSkillTool can be driven by the rows executeQuery
// resolves to (the Drizzle query-builder callback is never run) — same pattern
// as tests/unit/skill-tool-enforcement.test.ts.
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
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

// The executor reads the promoted SKILL.md from S3 via the publish pipeline;
// mock it so the test controls the document (or its absence).
const readSkillMarkdownMock = jest.fn()
jest.mock("@/lib/skills/skill-publish-pipeline", () => ({
  readSkillMarkdown: (...args: unknown[]) => readSkillMarkdownMock(...args),
}))

import {
  executeSkillTool,
  parseSkillHandlerRef,
} from "@/lib/skills/skill-tool-executor"

describe("parseSkillHandlerRef", () => {
  it("extracts the skill id from a skill: ref", () => {
    expect(
      parseSkillHandlerRef("skill:11111111-1111-1111-1111-111111111111")
    ).toBe("11111111-1111-1111-1111-111111111111")
  })

  it("returns null for null and undefined", () => {
    expect(parseSkillHandlerRef(null)).toBeNull()
    expect(parseSkillHandlerRef(undefined)).toBeNull()
  })

  it("returns null for a non-skill handlerRef", () => {
    expect(parseSkillHandlerRef("assistant:5")).toBeNull()
  })

  it("returns null for a skill: ref with an empty id", () => {
    expect(parseSkillHandlerRef("skill:")).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(parseSkillHandlerRef("")).toBeNull()
  })

  it("returns null for a whitespace-only id", () => {
    expect(parseSkillHandlerRef("skill:   ")).toBeNull()
  })
})

describe("executeSkillTool", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
    readSkillMarkdownMock.mockReset()
  })

  it("returns an isError 'not available' result for an unknown/unapproved skill", async () => {
    // No matching row: unknown id, or a skill that is no longer
    // scope=shared + scan_status=clean (fail closed, same message either way).
    executeQueryMock.mockResolvedValue([])

    const result = await executeSkillTool("bogus-id")

    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    expect(result.content[0].text).toContain("not available")
    // The S3 read must never happen for an unapproved skill.
    expect(readSkillMarkdownMock).not.toHaveBeenCalled()
  })

  it("returns an isError 'could not be loaded' result when SKILL.md is unreadable", async () => {
    executeQueryMock.mockResolvedValue([
      { name: "weather-helper", s3Key: "skills/shared/weather-helper/" },
    ])
    readSkillMarkdownMock.mockResolvedValue(null)

    const result = await executeSkillTool("skill-id")

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("could not be loaded")
    // The message names the skill so the model/admin can act on it.
    expect(result.content[0].text).toContain("weather-helper")
    expect(readSkillMarkdownMock).toHaveBeenCalledWith(
      "skills/shared/weather-helper/"
    )
  })

  it("returns the full SKILL.md as the tool result for an approved skill", async () => {
    const skillMd =
      "---\nname: weather-helper\nsummary: Looks up the weather\n---\n\n# Weather Helper\n\nInstructions."
    executeQueryMock.mockResolvedValue([
      { name: "weather-helper", s3Key: "skills/shared/weather-helper/" },
    ])
    readSkillMarkdownMock.mockResolvedValue(skillMd)

    const result = await executeSkillTool("skill-id")

    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    // The complete scanned document is returned verbatim, prefixed with the
    // load banner (progressive disclosure — the model follows it from here).
    expect(result.content[0].text).toContain(skillMd)
    expect(result.content[0].text).toContain('Skill "weather-helper" loaded')
  })
})
