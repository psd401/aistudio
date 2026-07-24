import { describe, it, expect, beforeEach } from "@jest/globals"

// The catalog reads non-code rows from the DB; mock that to a controllable set.
// Manifest (code) entries are read from the real manifest constant.
let dbRows: Record<string, unknown>[] = []

jest.mock("drizzle-orm", () => ({
  ne: (...args: unknown[]) => ({ op: "ne", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
}))

jest.mock("@/lib/db/schema", () => ({
  toolCatalog: { table: "tool_catalog", source: "tool_catalog.source" },
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => Promise.resolve(dbRows)),
}))

// Shared logger singleton so tests can inspect the same instance the catalog
// captures at module load. The singleton lives entirely inside the (hoisted)
// factory — referencing any top-level `const` here would throw, because
// `import { ToolCatalog }` is hoisted above this file and calls createLogger()
// before top-level declarations initialize. Tests retrieve the instance via
// `jest.requireMock("@/lib/logger").createLogger()` (idempotent — same object).
jest.mock("@/lib/logger", () => {
  const singleton = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { createLogger: () => singleton }
})

// The catalog lazily imports tool-handlers (real service/DB layer) at dispatch
// time. Mock it so dispatch resolves without pulling the DB/auth modules.
jest.mock("@/lib/mcp/tool-handlers", () => ({
  TOOL_HANDLERS: {
    search_decisions: jest.fn(),
    capture_decision: jest.fn(),
    execute_assistant: jest.fn(),
    list_assistants: jest.fn(),
    get_decision_graph: jest.fn(),
  },
}))

// dispatch() lazily imports the skill executor for `skill:{id}` handlerRefs
// (#925). Mock it so skill dispatch resolves without the S3/DB graph.
jest.mock("@/lib/skills/skill-tool-executor", () => ({
  executeSkillTool: jest.fn(),
}))

import { ToolCatalog } from "@/lib/tools/catalog/catalog"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"

// Derive expected MCP tool count from the manifest rather than hardcoding it,
// so adding/removing an MCP-surface manifest tool updates these assertions
// automatically (a hardcoded count would silently pass even if a newly-added
// MCP tool were incorrectly filtered out). (PR #1032 review finding #3.)
const MCP_TOOL_COUNT = TOOL_MANIFEST.filter((t) =>
  t.surfaces.includes("mcp")
).length

describe("ToolCatalog", () => {
  beforeEach(() => {
    dbRows = []
  })

  it("lists MCP-surface tools and filters by scope", async () => {
    const catalog = new ToolCatalog()
    // Caller with only search scope sees exactly one MCP tool.
    const tools = await catalog.list({
      surface: "mcp",
      scopes: ["mcp:search_decisions"],
    })
    expect(tools.map((t) => t.name)).toEqual(["search_decisions"])
  })

  it("wildcard scope sees all MCP tools", async () => {
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "mcp", scopes: ["*"] })
    expect(tools.length).toBe(MCP_TOOL_COUNT)
    expect(tools.every((t) => t.surfaces.includes("mcp"))).toBe(true)
  })

  it("serves the PUBLISHED (DB) schema for a code tool, not the manifest's (#927 immutability — PR #1129 review)", async () => {
    // Simulate a frozen immutability violation: the DB row (published contract)
    // holds a different input schema than the in-memory manifest. The runtime
    // must serve the DB schema — otherwise a refused manifest edit would still
    // be exposed via tools/list, REST metadata, and model tool schemas.
    const publishedSchema = {
      type: "object",
      properties: { frozen: { type: "string", description: "published" } },
    }
    dbRows = [
      {
        identifier: "decisions.search",
        // Must match the manifest's CURRENT version — the DB-beats-manifest
        // assertion only holds when both sides describe the same version.
        version: "v2",
        name: "search_decisions",
        description: "published description",
        inputSchema: publishedSchema,
        outputSchema: null,
        surfaces: ["mcp", "internal"],
        requiredScopes: ["mcp:search_decisions"],
        agentCallable: true,
        source: "code",
        isActive: true,
        deprecatedAt: null,
        replacedBy: null,
        removalDate: null,
        handlerRef: "decisions.search",
      },
    ]
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "mcp", scopes: ["*"] })
    const search = tools.find((t) => t.identifier === "decisions.search")
    expect(search).toBeDefined()
    expect(search!.inputSchema).toEqual(publishedSchema)
  })

  it("filters AI SDK tools by surface", async () => {
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "ai_sdk", scopes: ["*"] })
    const names = tools.map((t) => t.name)
    // Assert membership (not exact length/order) so adding a manifest tool does
    // not break this test.
    expect(names).toEqual(expect.arrayContaining([
      "code_interpreter",
      "generateImage",
      "show_chart",
      "web_search_preview",
    ]))
    expect(tools.every((t) => t.surfaces.includes("ai_sdk"))).toBe(true)
  })

  it("filterAiSdkToolNames drops tools the caller lacks scope for", async () => {
    const catalog = new ToolCatalog()
    // No chat:write -> only show_chart (no scope) survives; an uncataloged name
    // passes through untouched.
    const allowed = await catalog.filterAiSdkToolNames(
      ["show_chart", "web_search_preview", "uncataloged_tool"],
      []
    )
    expect(allowed.sort()).toEqual(["show_chart", "uncataloged_tool"])
  })

  it("filterAiSdkToolNames keeps scoped tools when the scope is held", async () => {
    const catalog = new ToolCatalog()
    const allowed = await catalog.filterAiSdkToolNames(
      ["show_chart", "web_search_preview"],
      ["chat:write"]
    )
    expect(allowed.sort()).toEqual(["show_chart", "web_search_preview"])
  })

  it("filterAiSdkToolNames scope-gates client-supplied friendly aliases", async () => {
    const catalog = new ToolCatalog()
    // The client sends the friendly names (webSearch/codeInterpreter), not the
    // catalog wire names. Without chat:write these must be dropped, not passed
    // through as 'uncataloged'.
    const denied = await catalog.filterAiSdkToolNames(
      ["webSearch", "codeInterpreter"],
      []
    )
    expect(denied).toEqual([])

    const allowed = await catalog.filterAiSdkToolNames(
      ["webSearch", "codeInterpreter"],
      ["chat:write"]
    )
    expect(allowed.sort()).toEqual(["codeInterpreter", "webSearch"])
  })

  it("respects an admin-disabled code tool (DB is_active=false)", async () => {
    dbRows = [
      {
        identifier: "decisions.search",
        // Matches the manifest's current version so the disable applies to the
        // row the manifest would otherwise project.
        version: "v2",
        name: "search_decisions",
        description: "x",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp"],
        requiredScopes: ["mcp:search_decisions"],
        agentCallable: true,
        source: "code",
        isActive: false,
        handlerRef: "decisions.search",
      },
    ]
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "mcp", scopes: ["*"] })
    // The manifest projection must NOT force the admin-disabled tool back to active.
    expect(tools.some((t) => t.name === "search_decisions")).toBe(false)
    // Dispatch of the disabled tool is rejected as unknown.
    const result = await catalog.dispatch(
      "search_decisions",
      {},
      { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
    )
    expect(result.ok).toBe(false)
  })

  it("agentOnly excludes non-agent-callable DB tools", async () => {
    dbRows = [
      {
        identifier: "assistants.destructive",
        version: "v1",
        name: "destructive",
        description: "x",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp"],
        requiredScopes: [],
        agentCallable: false,
        source: "assistant",
        isActive: true,
        handlerRef: "assistant:1",
      },
    ]
    const catalog = new ToolCatalog()
    const all = await catalog.list({ surface: "mcp", scopes: ["*"] })
    expect(all.some((t) => t.name === "destructive")).toBe(true)
    const agentTools = await catalog.list({
      surface: "mcp",
      scopes: ["*"],
      agentOnly: true,
    })
    expect(agentTools.some((t) => t.name === "destructive")).toBe(false)
  })

  it("merges DB (assistant) tools with manifest tools", async () => {
    dbRows = [
      {
        identifier: "assistants.custom",
        version: "v1",
        name: "custom_assistant",
        description: "x",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp"],
        requiredScopes: [],
        agentCallable: true,
        source: "assistant",
        isActive: true,
        handlerRef: "assistant:42",
      },
    ]
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "mcp", scopes: ["*"] })
    expect(tools.some((t) => t.name === "custom_assistant")).toBe(true)
    expect(tools.some((t) => t.name === "search_decisions")).toBe(true)
  })

  it("dispatch denies a tool the caller lacks scope for", async () => {
    const catalog = new ToolCatalog()
    const result = await catalog.dispatch(
      "search_decisions",
      {},
      { userId: 1, cognitoSub: "s", scopes: [], requestId: "r" }
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("scope_denied")
  })

  it("dispatch reports unknown for an unknown tool", async () => {
    const catalog = new ToolCatalog()
    const result = await catalog.dispatch(
      "no_such_tool",
      {},
      { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("unknown")
  })

  it("dispatch reports unknown for an ai_sdk-only tool over MCP", async () => {
    const catalog = new ToolCatalog()
    // show_chart is an ai_sdk surface tool; it must not be dispatchable via MCP.
    const result = await catalog.dispatch(
      "show_chart",
      {},
      { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("unknown")
  })

  it("dispatch on the internal surface succeeds for an agent tool (#926)", async () => {
    // The agentic runtime dispatches catalog tools on the 'internal' surface.
    // Without the surface param this would default to 'mcp'; the manifest MCP
    // tools are on BOTH surfaces, so dispatch must succeed on 'internal' too.
    const catalog = new ToolCatalog()
    const result = await catalog.dispatch(
      "search_decisions",
      {},
      { userId: 1, cognitoSub: "s", scopes: ["mcp:search_decisions"], requestId: "r" },
      "internal"
    )
    // The mocked handler returns undefined (jest.fn), so ok is true with a
    // handler invoked — the key assertion is it is NOT rejected as unknown.
    expect(result.ok === false && result.reason === "unknown").toBe(false)
  })

  it("dispatch on the internal surface uses the internal scope (#926)", async () => {
    // The internal surfaceScopes for search_decisions is ['mcp:search_decisions'].
    // A caller without it must be scope_denied on the internal surface.
    const catalog = new ToolCatalog()
    const result = await catalog.dispatch(
      "search_decisions",
      {},
      { userId: 1, cognitoSub: "s", scopes: [], requestId: "r" },
      "internal"
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("scope_denied")
  })

  it("degrades to manifest-only when the DB read fails", async () => {
    const { executeQuery } = jest.requireMock("@/lib/db/drizzle-client") as {
      executeQuery: jest.Mock
    }
    executeQuery.mockRejectedValueOnce(new Error("db down"))
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "mcp", scopes: ["*"] })
    // The manifest MCP tools are still returned.
    expect(tools.length).toBe(MCP_TOOL_COUNT)
  })

  it("invalidate() busts the DB cache so a later list() sees new rows", async () => {
    const catalog = new ToolCatalog()
    // Warm the cache with no DB rows.
    const before = await catalog.list({ surface: "mcp", scopes: ["*"] })
    expect(before.some((t) => t.name === "late_assistant")).toBe(false)

    // Add a DB row, then invalidate so the next list() re-reads from the DB
    // instead of serving the warm (now-stale) cache.
    dbRows = [
      {
        identifier: "assistants.late",
        version: "v1",
        name: "late_assistant",
        description: "x",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp"],
        requiredScopes: [],
        agentCallable: true,
        source: "assistant",
        isActive: true,
        handlerRef: "assistant:7",
      },
    ]
    catalog.invalidate()

    const after = await catalog.list({ surface: "mcp", scopes: ["*"] })
    expect(after.some((t) => t.name === "late_assistant")).toBe(true)
  })

  it("filterAiSdkToolNames caps per-name pass-through logging and warns on overflow", async () => {
    // The catalog captures the shared logger at module load; retrieve the same
    // singleton instance (createLogger returns the same object every call).
    const { createLogger } = jest.requireMock("@/lib/logger") as {
      createLogger: () => { info: jest.Mock; warn: jest.Mock }
    }
    const mockLogger = createLogger()
    mockLogger.info.mockClear()
    mockLogger.warn.mockClear()

    const catalog = new ToolCatalog()
    // 8 fabricated names -> all pass through, but only 5 info logs + 1 warn.
    const fabricated = Array.from({ length: 8 }, (_, i) => `fake_tool_${i}`)
    const allowed = await catalog.filterAiSdkToolNames(fabricated, [])
    expect(allowed.sort()).toEqual(fabricated.sort())

    const infoCalls = mockLogger.info.mock.calls.filter(
      (c) => c[0] === "Requested tool not in catalog; passing through unscoped"
    )
    expect(infoCalls.length).toBe(5)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Many uncataloged tool names passed through unscoped in one request",
      expect.objectContaining({ total: 8, logged: 5, suppressed: 3 })
    )
  })

  // Per-surface scope resolution (#924 follow-up): a tool on both mcp + rest
  // carries different scope vocabularies per surface (mcp:execute_assistant vs
  // assistants:execute). Scope filtering must use the surface-specific scope.
  describe("per-surface scopes", () => {
    it("lists assistants.execute on the rest surface for an assistants:execute caller", async () => {
      const catalog = new ToolCatalog()
      const tools = await catalog.list({
        surface: "rest",
        scopes: ["assistants:execute"],
      })
      expect(tools.some((t) => t.identifier === "assistants.execute")).toBe(true)
    })

    it("does NOT expose the rest tool to a caller holding only the MCP scope", async () => {
      const catalog = new ToolCatalog()
      const tools = await catalog.list({
        surface: "rest",
        scopes: ["mcp:execute_assistant"],
      })
      expect(tools.some((t) => t.identifier === "assistants.execute")).toBe(false)
    })

    it("still gates the MCP surface by the MCP scope", async () => {
      const catalog = new ToolCatalog()
      const tools = await catalog.list({
        surface: "mcp",
        scopes: ["mcp:execute_assistant"],
      })
      expect(tools.some((t) => t.identifier === "assistants.execute")).toBe(true)
    })

    it("getRequiredScopes returns the surface-specific scope", async () => {
      const catalog = new ToolCatalog()
      expect(await catalog.getRequiredScopes("assistants.execute", "rest")).toEqual([
        "assistants:execute",
      ])
      expect(await catalog.getRequiredScopes("assistants.execute", "mcp")).toEqual([
        "mcp:execute_assistant",
      ])
      expect(await catalog.getRequiredScopes("no.such.tool", "rest")).toBeUndefined()
    })

    it("get() surfaces is_active=false so the REST route can gate on it", async () => {
      // The REST execute route reads entry.isActive to deny when an admin disables
      // the tool (the MCP surface gates via dispatch()). get() must therefore return
      // the inactive entry rather than hiding it.
      //
      // The DB row disabling a code tool is keyed by identifier@version, so its
      // version MUST match the manifest entry's current version — derive it from
      // the manifest so a manifest version bump can never silently orphan this row.
      const assistantsExecuteVersion = TOOL_MANIFEST.find(
        (t) => t.identifier === "assistants.execute"
      )!.version
      dbRows = [
        {
          identifier: "assistants.execute",
          version: assistantsExecuteVersion,
          name: "execute_assistant",
          description: "x",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["mcp", "rest"],
          requiredScopes: ["mcp:execute_assistant"],
          agentCallable: true,
          source: "code",
          isActive: false,
          handlerRef: "assistants.execute",
        },
      ]
      const catalog = new ToolCatalog()
      const entry = await catalog.get("assistants.execute")
      expect(entry).toBeDefined()
      expect(entry?.isActive).toBe(false)
      // Scope is still resolvable even while disabled (so the route can choose 404).
      expect(await catalog.getRequiredScopes("assistants.execute", "rest")).toEqual([
        "assistants:execute",
      ])
    })
  })

  // Issue #926: image gen / web fetch / document gen are agent platform tools.
  describe("agent platform tools (#926)", () => {
    const AGENT_TOOL_IDS = ["images.generate", "web.fetch", "documents.create"]

    it("are in the manifest on the internal surface only, agentCallable, chat:write", () => {
      for (const id of AGENT_TOOL_IDS) {
        const entry = TOOL_MANIFEST.find((t) => t.identifier === id)
        expect(entry).toBeDefined()
        expect(entry!.surfaces).toEqual(["internal"])
        // Not advertised to the external MCP server or REST.
        expect(entry!.surfaces).not.toContain("mcp")
        expect(entry!.surfaces).not.toContain("rest")
        expect(entry!.agentCallable).toBe(true)
        expect(entry!.requiredScopes).toEqual(["chat:write"])
      }
    })

    it("list({surface:'internal', agentOnly}) returns them for a chat:write caller", async () => {
      const catalog = new ToolCatalog()
      const tools = await catalog.list({
        surface: "internal",
        scopes: ["chat:write"],
        agentOnly: true,
      })
      const ids = new Set(tools.map((t) => t.identifier))
      for (const id of AGENT_TOOL_IDS) {
        expect(ids.has(id)).toBe(true)
      }
    })

    it("are hidden from a caller without chat:write", async () => {
      const catalog = new ToolCatalog()
      const tools = await catalog.list({
        surface: "internal",
        scopes: ["assistants:read"],
        agentOnly: true,
      })
      const ids = new Set(tools.map((t) => t.identifier))
      for (const id of AGENT_TOOL_IDS) {
        expect(ids.has(id)).toBe(false)
      }
    })

    it("are not destructive (no confirmation gate)", () => {
      for (const id of AGENT_TOOL_IDS) {
        const entry = TOOL_MANIFEST.find((t) => t.identifier === id)
        expect(entry?.destructive ?? false).toBe(false)
      }
    })
  })

  // Issue #927: version resolution + deprecation lifecycle.
  describe("version resolution + deprecation (#927)", () => {
    function deprecatedDbRow(
      identifier: string,
      version: string,
      opts: { replacedBy?: string; removalDate?: string } = {}
    ) {
      return {
        identifier,
        version,
        name: `${identifier}_${version}`,
        description: "x",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp"],
        requiredScopes: [],
        agentCallable: true,
        source: "assistant",
        isActive: true,
        deprecatedAt: new Date("2026-01-01T00:00:00Z"),
        replacedBy: opts.replacedBy ?? null,
        removalDate: opts.removalDate ? new Date(opts.removalDate) : null,
        handlerRef: "assistant:1",
      }
    }

    it("listVersions returns all versions of an identifier, highest first", async () => {
      dbRows = [
        deprecatedDbRow("assistants.multi", "v1", { replacedBy: "assistants.multi@v2" }),
        {
          ...deprecatedDbRow("assistants.multi", "v2"),
          deprecatedAt: null,
        },
      ]
      const catalog = new ToolCatalog()
      const versions = await catalog.listVersions("assistants.multi")
      expect(versions.map((v) => v.version)).toEqual(["v2", "v1"])
    })

    it("resolve() with no pin returns the latest non-deprecated version", async () => {
      dbRows = [
        deprecatedDbRow("assistants.multi", "v1"),
        {
          ...deprecatedDbRow("assistants.multi", "v2"),
          deprecatedAt: null,
        },
      ]
      const catalog = new ToolCatalog()
      const r = await catalog.resolve("assistants.multi")
      expect(r.ok).toBe(true)
      expect(r.ok && r.entry.version).toBe("v2")
      expect(r.ok && r.deprecated).toBe(false)
    })

    it("resolve() with an explicit @version returns that version", async () => {
      dbRows = [
        deprecatedDbRow("assistants.multi", "v1", { replacedBy: "assistants.multi@v2" }),
        { ...deprecatedDbRow("assistants.multi", "v2"), deprecatedAt: null },
      ]
      const catalog = new ToolCatalog()
      const r = await catalog.resolve("assistants.multi@v1")
      expect(r.ok).toBe(true)
      expect(r.ok && r.entry.version).toBe("v1")
      expect(r.ok && r.deprecated).toBe(true)
    })

    it("resolve() returns unknown_version for a removed pin", async () => {
      dbRows = [{ ...deprecatedDbRow("assistants.multi", "v1"), deprecatedAt: null }]
      const catalog = new ToolCatalog()
      const r = await catalog.resolve("assistants.multi@v9")
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe("unknown_version")
    })

    it("resolve() returns malformed_ref for an invalid reference", async () => {
      const catalog = new ToolCatalog()
      const r = await catalog.resolve("assistants.multi@2")
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe("malformed_ref")
    })

    it("resolve() returns unknown_identifier for an unknown tool", async () => {
      const catalog = new ToolCatalog()
      const r = await catalog.resolve("no.such.tool")
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toBe("unknown_identifier")
    })

    it("resolve() emits deprecated_tool_invocation telemetry when context is supplied", async () => {
      const { createLogger } = jest.requireMock("@/lib/logger") as {
        createLogger: () => { warn: jest.Mock }
      }
      const mockLogger = createLogger()
      mockLogger.warn.mockClear()

      dbRows = [
        deprecatedDbRow("assistants.multi", "v1", {
          replacedBy: "assistants.multi@v2",
          removalDate: "2026-04-01T00:00:00Z",
        }),
      ]
      const catalog = new ToolCatalog()
      const r = await catalog.resolve("assistants.multi@v1", {
        callerType: "skill",
        callerId: "skill-42",
      })
      expect(r.ok).toBe(true)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "deprecated_tool_invocation",
        expect.objectContaining({
          tool: "assistants.multi@v1",
          identifier: "assistants.multi",
          version: "v1",
          callerType: "skill",
          callerId: "skill-42",
          replacedBy: "assistants.multi@v2",
        })
      )
    })

    it("resolve() does NOT emit telemetry when no context is supplied", async () => {
      const { createLogger } = jest.requireMock("@/lib/logger") as {
        createLogger: () => { warn: jest.Mock }
      }
      const mockLogger = createLogger()
      mockLogger.warn.mockClear()

      dbRows = [deprecatedDbRow("assistants.multi", "v1")]
      const catalog = new ToolCatalog()
      await catalog.resolve("assistants.multi@v1")
      const deprecationCalls = mockLogger.warn.mock.calls.filter(
        (c) => c[0] === "deprecated_tool_invocation"
      )
      expect(deprecationCalls.length).toBe(0)
    })

    it("list({excludeDeprecated}) hides deprecated versions", async () => {
      dbRows = [
        deprecatedDbRow("assistants.multi", "v1"),
        { ...deprecatedDbRow("assistants.multi", "v2"), deprecatedAt: null },
      ]
      const catalog = new ToolCatalog()
      const all = await catalog.list({ surface: "mcp", scopes: ["*"] })
      const filtered = await catalog.list({
        surface: "mcp",
        scopes: ["*"],
        excludeDeprecated: true,
      })
      expect(all.some((t) => t.identifier === "assistants.multi" && t.version === "v1")).toBe(true)
      expect(filtered.some((t) => t.identifier === "assistants.multi" && t.version === "v1")).toBe(false)
      expect(filtered.some((t) => t.identifier === "assistants.multi" && t.version === "v2")).toBe(true)
    })

    it("dispatch emits deprecation telemetry for an authorized deprecated tool call", async () => {
      const { createLogger } = jest.requireMock("@/lib/logger") as {
        createLogger: () => { warn: jest.Mock }
      }
      const mockLogger = createLogger()
      mockLogger.warn.mockClear()

      // A deprecated CODE tool (search_decisions v2, the manifest's current
      // version) — admin deprecated it in DB.
      dbRows = [
        {
          identifier: "decisions.search",
          version: "v2",
          name: "search_decisions",
          description: "x",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["mcp"],
          requiredScopes: ["mcp:search_decisions"],
          agentCallable: true,
          source: "code",
          isActive: true,
          deprecatedAt: new Date("2026-01-01T00:00:00Z"),
          replacedBy: "decisions.search@v3",
          removalDate: new Date("2026-04-01T00:00:00Z"),
          handlerRef: "decisions.search",
        },
      ]
      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "search_decisions",
        {},
        { userId: 7, cognitoSub: "s", scopes: ["*"], requestId: "r" }
      )
      // The mocked handler returns undefined; the key check is it dispatched.
      expect(result.ok === false && result.reason === "unknown").toBe(false)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "deprecated_tool_invocation",
        expect.objectContaining({
          tool: "decisions.search@v2",
          callerType: "mcp_client",
          callerId: "7",
          replacedBy: "decisions.search@v3",
        })
      )
    })
  })

  // Issue #926: destructive flag drives the human-in-the-loop confirmation gate.
  describe("destructive flag (#926)", () => {
    it("marks decisions.capture (a writing tool) destructive", () => {
      const entry = TOOL_MANIFEST.find((t) => t.identifier === "decisions.capture")
      expect(entry?.destructive).toBe(true)
    })

    it("leaves read-only tools non-destructive", () => {
      for (const id of ["decisions.search", "assistants.list", "decisions.graph_get"]) {
        const entry = TOOL_MANIFEST.find((t) => t.identifier === id)
        expect(entry?.destructive ?? false).toBe(false)
      }
    })

    it("projects destructive onto the runtime entry (default false)", async () => {
      const catalog = new ToolCatalog()
      const all = await catalog.list({ includeInactive: true })
      const capture = all.find((e) => e.identifier === "decisions.capture")
      const search = all.find((e) => e.identifier === "decisions.search")
      expect(capture?.destructive).toBe(true)
      expect(search?.destructive).toBe(false)
    })
  })

  // Issue #925 (epic #922 completion audit): skill-derived catalog rows carry
  // `handlerRef: skill:{id}` and dispatch through the lazily-imported skill
  // executor, never through TOOL_HANDLERS.
  describe("skill handlerRef dispatch (#925)", () => {
    const SKILL_ID = "11111111-1111-1111-1111-111111111111"

    function skillDbRow(over: Record<string, unknown> = {}) {
      return {
        identifier: "skill.weather-helper",
        version: "v1",
        name: "weather-helper",
        description: "Looks up the weather",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp", "internal"],
        requiredScopes: [],
        agentCallable: true,
        source: "skill",
        isActive: true,
        handlerRef: `skill:${SKILL_ID}`,
        ...over,
      }
    }

    function skillExecutorMock() {
      const { executeSkillTool } = jest.requireMock(
        "@/lib/skills/skill-tool-executor"
      ) as { executeSkillTool: jest.Mock }
      executeSkillTool.mockReset()
      return executeSkillTool
    }

    it("dispatches a skill tool via executeSkillTool and returns its result", async () => {
      dbRows = [skillDbRow()]
      const executeSkillTool = skillExecutorMock()
      const skillResult = {
        content: [{ type: "text", text: "SKILL.md contents" }],
      }
      executeSkillTool.mockResolvedValue(skillResult)

      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "weather-helper",
        {},
        { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
      )

      // ok:true itself proves the skill path was taken: "weather-helper" has no
      // TOOL_HANDLERS entry, so the code-handler path would have returned
      // {ok:false, reason:"no_handler"}.
      expect(result.ok).toBe(true)
      expect(result.ok && result.result).toBe(skillResult)
      expect(executeSkillTool).toHaveBeenCalledWith(SKILL_ID)
    })

    it("dispatches a skill tool on the internal surface too", async () => {
      dbRows = [skillDbRow()]
      const executeSkillTool = skillExecutorMock()
      executeSkillTool.mockResolvedValue({ content: [] })

      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "weather-helper",
        {},
        { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" },
        "internal"
      )
      expect(result.ok).toBe(true)
      expect(executeSkillTool).toHaveBeenCalledWith(SKILL_ID)
    })
  })

  // Issue #927 (epic #922 completion audit): dispatch supports `name@vN`
  // version-pinned addressing; a removed or malformed pin fails clearly as
  // unknown, never silently falling back to latest.
  describe("version-pinned dispatch addressing (#927)", () => {
    function pinnedSkillRow(version: string, skillId: string) {
      return {
        identifier: "skill.multi-skill",
        version,
        name: "multi-skill",
        description: "x",
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        surfaces: ["mcp"],
        requiredScopes: [],
        agentCallable: true,
        source: "skill",
        isActive: true,
        handlerRef: `skill:${skillId}`,
      }
    }

    function skillExecutorMock() {
      const { executeSkillTool } = jest.requireMock(
        "@/lib/skills/skill-tool-executor"
      ) as { executeSkillTool: jest.Mock }
      executeSkillTool.mockReset()
      return executeSkillTool
    }

    beforeEach(() => {
      // Two versions sharing one wire name; the handlerRef identifies which
      // version actually dispatched.
      dbRows = [pinnedSkillRow("v1", "id-v1"), pinnedSkillRow("v2", "id-v2")]
    })

    it("dispatch('name@v1') targets exactly v1 even when v2 exists", async () => {
      const executeSkillTool = skillExecutorMock()
      executeSkillTool.mockResolvedValue({ content: [] })

      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "multi-skill@v1",
        {},
        { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
      )
      expect(result.ok).toBe(true)
      expect(executeSkillTool).toHaveBeenCalledTimes(1)
      expect(executeSkillTool).toHaveBeenCalledWith("id-v1")
    })

    it("dispatch('name@v3') for a nonexistent version reports unknown", async () => {
      const executeSkillTool = skillExecutorMock()
      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "multi-skill@v3",
        {},
        { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe("unknown")
      expect(executeSkillTool).not.toHaveBeenCalled()
    })

    it("dispatch('name@banana') with a malformed pin reports unknown", async () => {
      const executeSkillTool = skillExecutorMock()
      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "multi-skill@banana",
        {},
        { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" }
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe("unknown")
      expect(executeSkillTool).not.toHaveBeenCalled()
    })
  })

  // Issue #926 defense-in-depth: the internal agent surface must never dispatch
  // a human-only (agentCallable=false) tool, even with valid scopes.
  describe("internal-surface agentCallable dispatch guard (#926)", () => {
    it("rejects an agentCallable=false tool on the internal surface as unknown", async () => {
      dbRows = [
        {
          identifier: "assistants.humanonly",
          version: "v1",
          name: "human_only",
          description: "x",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["internal"],
          requiredScopes: [],
          agentCallable: false,
          source: "assistant",
          isActive: true,
          handlerRef: "assistant:9",
        },
      ]
      const catalog = new ToolCatalog()
      const result = await catalog.dispatch(
        "human_only",
        {},
        { userId: 1, cognitoSub: "s", scopes: ["*"], requestId: "r" },
        "internal"
      )
      expect(result.ok).toBe(false)
      // Reported as unknown (not scope_denied) so the tool's existence does not
      // leak to the agent loop.
      expect(result.ok === false && result.reason).toBe("unknown")
    })
  })
})
