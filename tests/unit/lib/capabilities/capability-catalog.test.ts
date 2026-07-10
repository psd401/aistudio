import { describe, it, expect } from "@jest/globals"

// Pure-builder unit tests (Issue #1100). buildCapabilityCatalog reads only the
// real metadata registries (TOOL_MANIFEST, CAPABILITY_MANIFEST, API_SCOPES/
// ROLE_SCOPES) — no DB, no handlers — so nothing needs mocking here.
import { buildCapabilityCatalog } from "@/lib/capabilities/capability-catalog"
import { CAPABILITY_MANIFEST } from "@/lib/capabilities/manifest"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"

describe("buildCapabilityCatalog", () => {
  it("includes a known action and a known feature (DoD)", () => {
    const cat = buildCapabilityCatalog()
    expect(cat.actions?.some((a) => a.identifier === "assistants.execute")).toBe(
      true
    )
    expect(cat.features?.some((f) => f.identifier === "model-compare")).toBe(
      true
    )
  })

  it("projects describe_capabilities as an MCP-invocable action gated by platform:read", () => {
    const action = buildCapabilityCatalog().actions?.find(
      (a) => a.identifier === "platform.describe_capabilities"
    )
    expect(action).toBeDefined()
    expect(action?.name).toBe("describe_capabilities")
    expect(action?.agentInvocable).toBe(true)
    expect(action?.requiredScopes).toContain("platform:read")
    expect(action?.destructive).toBe(false)
  })

  it("exposes platform:read in the scope reference with the granting roles", () => {
    const scope = buildCapabilityCatalog().scopes?.find(
      (s) => s.scope === "platform:read"
    )
    expect(scope).toBeDefined()
    expect(scope?.roles).toEqual(
      expect.arrayContaining(["student", "staff", "administrator"])
    )
  })

  it("flags destructive actions and marks non-MCP surfaces as not agent-invocable", () => {
    const actions = buildCapabilityCatalog().actions ?? []
    // A content mutation is destructive AND (on the mcp surface) agent-invocable.
    const createDoc = actions.find((a) => a.identifier === "content.create_document")
    expect(createDoc?.destructive).toBe(true)
    expect(createDoc?.agentInvocable).toBe(true)
    // An ai_sdk-only action exists but is NOT reachable over MCP.
    const aiSdkOnly = actions.find(
      (a) => a.surfaces.length === 1 && a.surfaces[0] === "ai_sdk"
    )
    expect(aiSdkOnly).toBeDefined()
    expect(aiSdkOnly?.agentInvocable).toBe(false)
  })

  it("FRESHNESS: every CAPABILITY_MANIFEST entry is projected — no per-feature code", () => {
    // The core promise of #1100: the catalog is a projection, not a hand list.
    // Adding a CAPABILITY_MANIFEST entry surfaces here with zero other changes.
    const featureIds = new Set(
      buildCapabilityCatalog().features?.map((f) => f.identifier)
    )
    for (const entry of CAPABILITY_MANIFEST) {
      expect(featureIds.has(entry.identifier)).toBe(true)
    }
    expect(buildCapabilityCatalog().features).toHaveLength(
      CAPABILITY_MANIFEST.length
    )
  })

  it("FRESHNESS: every TOOL_MANIFEST identifier is projected into actions (deduped)", () => {
    const actionIds = new Set(
      buildCapabilityCatalog().actions?.map((a) => a.identifier)
    )
    const manifestIds = new Set(TOOL_MANIFEST.map((e) => e.identifier))
    for (const id of manifestIds) {
      expect(actionIds.has(id)).toBe(true)
    }
    expect(buildCapabilityCatalog().actions).toHaveLength(manifestIds.size)
  })

  it("keeps capabilities and scopes as separate namespaces (no cross-mapping)", () => {
    const cat = buildCapabilityCatalog()
    for (const f of cat.features ?? []) {
      expect(f).not.toHaveProperty("scope")
      expect(f).not.toHaveProperty("requiredScopes")
      expect(f.humanDriven).toBe(true)
    }
  })

  it("section filter returns only the requested section", () => {
    const cat = buildCapabilityCatalog({ section: "features" })
    expect(cat.features).toBeDefined()
    expect(cat.actions).toBeUndefined()
    expect(cat.scopes).toBeUndefined()
    expect(cat.summary.actions).toBe(0)
    expect(cat.summary.features).toBe(CAPABILITY_MANIFEST.length)
  })

  it("surface filter narrows actions; every mcp action is agent-invocable", () => {
    const cat = buildCapabilityCatalog({ section: "actions", surface: "mcp" })
    expect(cat.actions?.length).toBeGreaterThan(0)
    for (const a of cat.actions ?? []) {
      expect(a.surfaces).toContain("mcp")
      expect(a.agentInvocable).toBe(true)
    }
  })

  it("query filter matches across identifier/name/description", () => {
    const cat = buildCapabilityCatalog({ query: "describe_capabilities" })
    expect(
      cat.actions?.some((a) => a.identifier === "platform.describe_capabilities")
    ).toBe(true)
    expect(cat.actions?.some((a) => a.identifier === "decisions.search")).toBe(
      false
    )
  })

  it("summary counts match the returned arrays, incl. agentInvocableActions", () => {
    const cat = buildCapabilityCatalog()
    expect(cat.summary.actions).toBe(cat.actions?.length)
    expect(cat.summary.features).toBe(cat.features?.length)
    expect(cat.summary.scopes).toBe(cat.scopes?.length)
    expect(cat.summary.agentInvocableActions).toBe(
      cat.actions?.filter((a) => a.agentInvocable).length
    )
  })

  it("is deterministic and sorted by identifier / scope", () => {
    expect(JSON.stringify(buildCapabilityCatalog())).toBe(
      JSON.stringify(buildCapabilityCatalog())
    )
    const cat = buildCapabilityCatalog()
    const actionIds = cat.actions?.map((a) => a.identifier) ?? []
    expect(actionIds).toEqual(
      [...actionIds].sort((x, y) => x.localeCompare(y))
    )
    const scopeIds = cat.scopes?.map((s) => s.scope) ?? []
    expect(scopeIds).toEqual([...scopeIds].sort((x, y) => x.localeCompare(y)))
  })
})
