import { describe, it, expect } from "@jest/globals"
import {
  serializeToolEntry,
  normalizeVersionParam,
} from "@/lib/tools/catalog/rest-serializer"
import type { ToolCatalogEntry } from "@/lib/tools/catalog/types"

function entry(overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return {
    identifier: "documents.create",
    version: "v1",
    name: "create_document",
    description: "Create a document",
    inputSchema: { type: "object", properties: {} },
    surfaces: ["internal"],
    requiredScopes: ["chat:write"],
    agentCallable: true,
    destructive: false,
    source: "code",
    isActive: true,
    handlerRef: "documents.create",
    ...overrides,
  }
}

describe("serializeToolEntry", () => {
  it("projects a non-deprecated entry", () => {
    const result = serializeToolEntry(entry())
    expect(result).toMatchObject({
      identifier: "documents.create",
      version: "v1",
      name: "create_document",
      deprecated: false,
      deprecatedAt: null,
      replacedBy: null,
      removalDate: null,
    })
  })

  it("does NOT leak internal-only fields (handlerRef, surfaceScopes)", () => {
    const result = serializeToolEntry(
      entry({ handlerRef: "secret", surfaceScopes: { rest: ["x"] } })
    )
    expect("handlerRef" in result).toBe(false)
    expect("surfaceScopes" in result).toBe(false)
  })

  it("serializes deprecation fields to ISO strings + booleans", () => {
    const deprecatedAt = new Date("2026-01-01T00:00:00Z")
    const removalDate = new Date("2026-04-01T00:00:00Z")
    const result = serializeToolEntry(
      entry({
        version: "v1",
        deprecatedAt,
        replacedBy: "documents.create@v2",
        removalDate,
      })
    )
    expect(result.deprecated).toBe(true)
    expect(result.deprecatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(result.replacedBy).toBe("documents.create@v2")
    expect(result.removalDate).toBe("2026-04-01T00:00:00.000Z")
  })
})

describe("normalizeVersionParam", () => {
  it("accepts a vN token", () => {
    expect(normalizeVersionParam("v2")).toBe("v2")
  })

  it("converts a bare positive integer to vN", () => {
    expect(normalizeVersionParam("3")).toBe("v3")
  })

  it("trims whitespace", () => {
    expect(normalizeVersionParam("  v1 ")).toBe("v1")
  })

  it("rejects zero and negatives", () => {
    expect(normalizeVersionParam("0")).toBeNull()
    expect(normalizeVersionParam("-1")).toBeNull()
  })

  it("rejects non-numeric junk", () => {
    expect(normalizeVersionParam("latest")).toBeNull()
    expect(normalizeVersionParam("")).toBeNull()
    expect(normalizeVersionParam("v")).toBeNull()
  })
})
