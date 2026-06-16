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

import { handleJsonRpcRequest } from "@/lib/mcp/jsonrpc-handler"
import type { McpToolContext } from "@/lib/mcp/types"
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest"

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
})
