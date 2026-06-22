/**
 * Unit tests for skill → tool catalog registration helpers (Issue #925, AC#5).
 * Pure functions only — the identifier scheme and catalog row shape.
 */

import {
  buildSkillCatalogIdentifier,
  buildSkillCatalogToolName,
  buildSkillCatalogToolValues,
  SKILL_CATALOG_VERSION,
} from "@/lib/skills/skill-catalog-registration"

describe("buildSkillCatalogIdentifier", () => {
  it("namespaces the slug under skill.", () => {
    expect(buildSkillCatalogIdentifier("my-skill")).toBe("skill.my-skill")
  })
})

describe("buildSkillCatalogToolName", () => {
  it("uses the slug as the wire name", () => {
    expect(buildSkillCatalogToolName("my-skill")).toBe("my-skill")
  })
})

describe("buildSkillCatalogToolValues", () => {
  const values = buildSkillCatalogToolValues({
    skillId: "11111111-1111-1111-1111-111111111111",
    slug: "weather-helper",
    summary: "Looks up the weather",
  })

  it("marks the row as a skill source", () => {
    expect(values.source).toBe("skill")
  })

  it("points handlerRef at the skill id", () => {
    expect(values.handlerRef).toBe("skill:11111111-1111-1111-1111-111111111111")
  })

  it("uses the stable skill identifier and version", () => {
    expect(values.identifier).toBe("skill.weather-helper")
    expect(values.version).toBe(SKILL_CATALOG_VERSION)
  })

  it("exposes the skill across chat, MCP, and internal agent surfaces", () => {
    expect(values.surfaces).toEqual(["ai_sdk", "mcp", "internal"])
  })

  it("is open to any authenticated caller (no required scopes) and agent-callable", () => {
    expect(values.requiredScopes).toEqual([])
    expect(values.agentCallable).toBe(true)
    expect(values.isActive).toBe(true)
  })

  it("carries the summary as the description", () => {
    expect(values.description).toBe("Looks up the weather")
  })

  it("provides a generic object input schema", () => {
    expect(values.inputSchema).toEqual({ type: "object", properties: {} })
  })
})
