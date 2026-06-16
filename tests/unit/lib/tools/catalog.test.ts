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

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

// The manifest imports tool-handlers (real service/DB layer) for code-tool
// handlers. Mock it so the manifest builds without pulling the DB modules.
jest.mock("@/lib/mcp/tool-handlers", () => ({
  TOOL_HANDLERS: {
    search_decisions: jest.fn(),
    capture_decision: jest.fn(),
    execute_assistant: jest.fn(),
    list_assistants: jest.fn(),
    get_decision_graph: jest.fn(),
  },
}))

import { ToolCatalog } from "@/lib/tools/catalog/catalog"

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
    expect(tools.length).toBe(5)
    expect(tools.every((t) => t.surfaces.includes("mcp"))).toBe(true)
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
        version: "v1",
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

  it("degrades to manifest-only when the DB read fails", async () => {
    const { executeQuery } = jest.requireMock("@/lib/db/drizzle-client") as {
      executeQuery: jest.Mock
    }
    executeQuery.mockRejectedValueOnce(new Error("db down"))
    const catalog = new ToolCatalog()
    const tools = await catalog.list({ surface: "mcp", scopes: ["*"] })
    // The 5 manifest MCP tools are still returned.
    expect(tools.length).toBe(5)
  })
})
