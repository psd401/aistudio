import { describe, it, expect, beforeEach } from "@jest/globals"

// Registration + scope-gating tests for the describe_capabilities MCP meta-tool
// (Issue #1100). Proves the tool is wired across the catalog touchpoints and that
// the platform:read scope gates both tools/list visibility and tools/call.
//
// Harness mirrors tests/unit/lib/mcp/jsonrpc-catalog.test.ts: the DB layer is
// mocked (manifest/code tools only), and TOOL_HANDLERS is mocked so dispatch
// resolves without pulling the real service/node:crypto graph. The
// describe_capabilities handler here delegates to the REAL builder so the
// tools/call assertion checks the actual projected catalog.

let dbRows: Record<string, unknown>[] = []
/* eslint-disable no-var */
// `var` so the (hoisted) jest.mock factory can reference it, matching the sibling
// jsonrpc-catalog harness.
var describeHandler: jest.Mock
/* eslint-enable no-var */

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
    describe_capabilities: (
      args: Record<string, unknown>,
      context: unknown
    ) => describeHandler(args, context),
  },
}))

import { handleJsonRpcRequest } from "@/lib/mcp/jsonrpc-handler"
import type { McpToolContext } from "@/lib/mcp/types"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"
import { buildCapabilityCatalog } from "@/lib/capabilities/capability-catalog"

// Delegate to the REAL builder so tools/call returns the actual catalog.
describeHandler = jest.fn(async (args: Record<string, unknown>) => ({
  content: [
    { type: "text", text: JSON.stringify(buildCapabilityCatalog(args)) },
  ],
}))

function ctx(scopes: string[]): McpToolContext {
  return { userId: 1, cognitoSub: "sub", scopes, requestId: "req" }
}

describe("describe_capabilities MCP meta-tool (#1100)", () => {
  beforeEach(() => {
    dbRows = []
    describeHandler.mockClear()
    // Bust the module-level catalog's 5-min DB cache between tests.
    toolCatalogInstance.invalidate()
  })

  it("tools/list exposes describe_capabilities to a platform:read caller", async () => {
    const res = await handleJsonRpcRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      ctx(["platform:read"])
    )
    const result = res.result as { tools: { name: string }[] }
    expect(result.tools.map((t) => t.name)).toContain("describe_capabilities")
  })

  it("tools/list hides describe_capabilities from a caller without platform:read", async () => {
    const res = await handleJsonRpcRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
      ctx(["mcp:search_decisions"])
    )
    const result = res.result as { tools: { name: string }[] }
    expect(result.tools.map((t) => t.name)).not.toContain(
      "describe_capabilities"
    )
  })

  it("tools/call returns actions[] and features[] with the expected known entries", async () => {
    const res = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 3,
        params: { name: "describe_capabilities", arguments: {} },
      },
      ctx(["platform:read"])
    )
    expect(describeHandler).toHaveBeenCalledTimes(1)
    const result = res.result as { content: { text: string }[] }
    const parsed = JSON.parse(result.content[0].text) as {
      actions: { identifier: string; agentInvocable: boolean }[]
      features: { identifier: string }[]
    }
    expect(Array.isArray(parsed.actions)).toBe(true)
    expect(Array.isArray(parsed.features)).toBe(true)
    expect(parsed.actions.some((a) => a.identifier === "assistants.execute")).toBe(
      true
    )
    expect(parsed.features.some((f) => f.identifier === "model-compare")).toBe(
      true
    )
    // The meta-tool advertises itself as agent-invocable.
    expect(
      parsed.actions.find(
        (a) => a.identifier === "platform.describe_capabilities"
      )?.agentInvocable
    ).toBe(true)
  })

  it("tools/call denies a caller without platform:read (Insufficient scope)", async () => {
    const res = await handleJsonRpcRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 4,
        params: { name: "describe_capabilities", arguments: {} },
      },
      ctx(["mcp:search_decisions"])
    )
    expect(describeHandler).not.toHaveBeenCalled()
    expect(res.error?.code).toBe(-32602)
    expect(res.error?.message).toMatch(/Insufficient scope/)
  })
})
