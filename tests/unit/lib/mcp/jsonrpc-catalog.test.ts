import { describe, it, expect, beforeEach } from "@jest/globals"

// Integration test for the catalog-backed MCP JSON-RPC path (#924). Exercises the
// acceptance-criteria flows:
//   - MCP tools/list returns catalog-backed tools (scope-filtered)
//   - MCP tools/call dispatches via the catalog handler
// The DB layer is mocked so only manifest (code) tools are in play; tool handlers
// are mocked so we can assert dispatch reaches them.

let dbRows: Record<string, unknown>[] = []
/* eslint-disable no-var */
// `var` so jest.mock's hoisting can reference it from the mock factory.
var searchHandler: jest.Mock
/* eslint-enable no-var */
searchHandler = jest.fn(async () => ({
  content: [{ type: "text", text: "ok" }],
}))

jest.mock("drizzle-orm", () => ({
  ne: (...args: unknown[]) => ({ op: "ne", args }),
}))

jest.mock("@/lib/db/schema", () => ({
  toolCatalog: { table: "tool_catalog", source: "tool_catalog.source" },
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(() => Promise.resolve(dbRows)),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("@/lib/mcp/tool-handlers", () => ({
  TOOL_HANDLERS: {
    search_decisions: (
      args: Record<string, unknown>,
      context: unknown
    ) => searchHandler(args, context),
    capture_decision: jest.fn(),
    execute_assistant: jest.fn(),
    list_assistants: jest.fn(),
    get_decision_graph: jest.fn(),
  },
}))

import {
  handleJsonRpcRequest,
  selectListedTools,
} from "@/lib/mcp/jsonrpc-handler"
import type { McpToolContext } from "@/lib/mcp/types"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"

// Derive the expected MCP tool count from the manifest so this test self-updates
// when an MCP tool is added/removed, rather than asserting a hardcoded length.
// (PR #1032 review finding #10.)
const MCP_TOOL_COUNT = TOOL_MANIFEST.filter((t) =>
  t.surfaces.includes("mcp")
).length

function ctx(scopes: string[]): McpToolContext {
  return { userId: 1, cognitoSub: "sub", scopes, requestId: "req" }
}

describe("MCP JSON-RPC via catalog", () => {
  beforeEach(() => {
    dbRows = []
    searchHandler.mockClear()
    // The JSON-RPC handler uses the module-level catalog singleton, which caches
    // DB rows for 5 min. Bust it between tests so each test's `dbRows` is read
    // fresh instead of serving a previous test's warm (stale) cache.
    toolCatalogInstance.invalidate()
  })

  it("tools/list returns catalog-backed MCP tools filtered by scope", async () => {
    const res = await handleJsonRpcRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      ctx(["mcp:search_decisions"])
    )
    const result = res.result as { tools: { name: string }[] }
    expect(result.tools.map((t) => t.name)).toEqual(["search_decisions"])
  })

  it("tools/list with wildcard returns all MCP tools", async () => {
    const res = await handleJsonRpcRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
      ctx(["*"])
    )
    const result = res.result as { tools: { name: string }[] }
    expect(result.tools).toHaveLength(MCP_TOOL_COUNT)
  })

  it("tools/call dispatches via the catalog handler", async () => {
    const res = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 3,
        params: { name: "search_decisions", arguments: { query: "x" } },
      },
      ctx(["mcp:search_decisions"])
    )
    expect(searchHandler).toHaveBeenCalledTimes(1)
    expect(res.result).toEqual({ content: [{ type: "text", text: "ok" }] })
  })

  it("tools/call denies a tool the caller lacks scope for (INVALID_PARAMS)", async () => {
    const res = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 4,
        params: { name: "search_decisions", arguments: {} },
      },
      ctx([])
    )
    expect(searchHandler).not.toHaveBeenCalled()
    expect(res.error?.code).toBe(-32602)
    expect(res.error?.message).toMatch(/Insufficient scope/)
  })

  it("tools/call returns METHOD_NOT_FOUND for an unknown tool", async () => {
    const res = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 5,
        params: { name: "no_such_tool", arguments: {} },
      },
      ctx(["*"])
    )
    expect(res.error?.code).toBe(-32601)
  })

  // Versioning (#927): tools/list hides deprecated versions by default and
  // collapses to the latest version per identifier; include:"all" returns all.
  describe("version filtering (#927)", () => {
    // A deprecated v1 + a live v2 of the same identifier as DB (assistant) rows.
    function multiVersionRows() {
      return [
        {
          identifier: "assistants.multi",
          version: "v1",
          name: "multi_v1",
          description: "old",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["mcp"],
          requiredScopes: [],
          agentCallable: true,
          source: "assistant",
          isActive: true,
          deprecatedAt: new Date("2026-01-01T00:00:00Z"),
          replacedBy: "assistants.multi@v2",
          removalDate: new Date("2026-04-01T00:00:00Z"),
          handlerRef: "assistant:1",
        },
        {
          identifier: "assistants.multi",
          version: "v2",
          name: "multi_v2",
          description: "new",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["mcp"],
          requiredScopes: [],
          agentCallable: true,
          source: "assistant",
          isActive: true,
          deprecatedAt: null,
          replacedBy: null,
          removalDate: null,
          handlerRef: "assistant:2",
        },
      ]
    }

    it("default tools/list hides the deprecated version and keeps the latest", async () => {
      dbRows = multiVersionRows()
      const res = await handleJsonRpcRequest(
        { jsonrpc: "2.0", method: "tools/list", id: 6 },
        ctx(["*"])
      )
      const result = res.result as {
        tools: { name: string; version: string; deprecated?: boolean }[]
      }
      const multi = result.tools.filter((t) => t.name.startsWith("multi_"))
      expect(multi).toHaveLength(1)
      expect(multi[0].name).toBe("multi_v2")
      expect(multi[0].version).toBe("v2")
      expect(multi[0].deprecated).toBeUndefined()
    })

    // All versions of one identifier deprecated (no live successor). `tools/call`
    // / `resolve()` would still dispatch the latest deprecated version, so the
    // default `tools/list` must surface it too — hiding it would make a callable
    // tool invisible (#1044 review: list-vs-call divergence).
    function allDeprecatedRows() {
      return [
        {
          identifier: "assistants.alldep",
          version: "v1",
          name: "alldep_v1",
          description: "old",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["mcp"],
          requiredScopes: [],
          agentCallable: true,
          source: "assistant",
          isActive: true,
          deprecatedAt: new Date("2026-01-01T00:00:00Z"),
          replacedBy: null,
          removalDate: new Date("2026-04-01T00:00:00Z"),
          handlerRef: "assistant:3",
        },
        {
          identifier: "assistants.alldep",
          version: "v2",
          name: "alldep_v2",
          description: "newer but also deprecated",
          inputSchema: { type: "object", properties: {} },
          outputSchema: null,
          surfaces: ["mcp"],
          requiredScopes: [],
          agentCallable: true,
          source: "assistant",
          isActive: true,
          deprecatedAt: new Date("2026-02-01T00:00:00Z"),
          replacedBy: null,
          removalDate: new Date("2026-05-01T00:00:00Z"),
          handlerRef: "assistant:4",
        },
      ]
    }

    it("default tools/list surfaces the latest deprecated version when ALL versions are deprecated", async () => {
      dbRows = allDeprecatedRows()
      const res = await handleJsonRpcRequest(
        { jsonrpc: "2.0", method: "tools/list", id: 8 },
        ctx(["*"])
      )
      const result = res.result as {
        tools: { name: string; version: string; deprecated?: boolean }[]
      }
      const allDep = result.tools.filter((t) => t.name.startsWith("alldep_"))
      // Visible (NOT hidden) and flagged deprecated — agrees with tools/call.
      expect(allDep).toHaveLength(1)
      expect(allDep[0].name).toBe("alldep_v2")
      expect(allDep[0].version).toBe("v2")
      expect(allDep[0].deprecated).toBe(true)
    })

    it("include:'all' returns every version, tagging deprecated ones", async () => {
      dbRows = multiVersionRows()
      const res = await handleJsonRpcRequest(
        { jsonrpc: "2.0", method: "tools/list", id: 7, params: { include: "all" } },
        ctx(["*"])
      )
      const result = res.result as {
        tools: {
          name: string
          version: string
          deprecated?: boolean
          replacedBy?: string | null
        }[]
      }
      const multi = result.tools.filter((t) => t.name.startsWith("multi_"))
      expect(multi.map((t) => t.version).sort()).toEqual(["v1", "v2"])
      const v1 = multi.find((t) => t.version === "v1")
      expect(v1?.deprecated).toBe(true)
      expect(v1?.replacedBy).toBe("assistants.multi@v2")
      const v2 = multi.find((t) => t.version === "v2")
      expect(v2?.deprecated).toBeUndefined()
    })
  })
})

describe("selectListedTools (#927)", () => {
  const tools = [
    { identifier: "a.x", version: "v1", name: "ax1" },
    { identifier: "a.x", version: "v2", name: "ax2" },
    { identifier: "b.y", version: "v1", name: "by1" },
  ]

  it("collapses to the latest version per identifier by default", () => {
    const result = selectListedTools(tools, false)
    expect(result).toHaveLength(2)
    const ax = result.find((t) => t.identifier === "a.x")
    expect(ax?.version).toBe("v2")
  })

  it("returns every entry when includeAll is true", () => {
    const result = selectListedTools(tools, true)
    expect(result).toHaveLength(3)
  })

  it("falls back to the latest deprecated version when every version is deprecated", () => {
    const allDeprecated = [
      {
        identifier: "c.z",
        version: "v1",
        name: "cz1",
        deprecatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        identifier: "c.z",
        version: "v2",
        name: "cz2",
        deprecatedAt: new Date("2026-02-01T00:00:00Z"),
      },
    ]
    const result = selectListedTools(allDeprecated, false)
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe("v2")
    expect(result[0].deprecatedAt).not.toBeNull()
  })

  it("prefers a live version over a higher deprecated version", () => {
    const mixed = [
      { identifier: "d.w", version: "v1", name: "dw1", deprecatedAt: null },
      {
        identifier: "d.w",
        version: "v2",
        name: "dw2",
        deprecatedAt: new Date("2026-02-01T00:00:00Z"),
      },
    ]
    const result = selectListedTools(mixed, false)
    expect(result).toHaveLength(1)
    // Latest NON-deprecated wins even though v2 is a higher version.
    expect(result[0].version).toBe("v1")
  })
})
