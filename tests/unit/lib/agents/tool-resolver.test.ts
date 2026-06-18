// NOTE: do NOT import `jest` from "@jest/globals" — doing so disables jest.mock
// hoisting (see docs/learnings: jest-mock-hoisting-disabled-by-jest-globals-import),
// which would leave the catalog/connector mocks unapplied. Use the global `jest`.
import { describe, it, expect, beforeEach } from "@jest/globals"
import type { ToolCatalogEntry } from "@/lib/tools/catalog/types"

// ── Mocks ────────────────────────────────────────────────────────────────────
// The catalog + connector service are mocked with jest.fn() created INSIDE each
// (hoisted) factory; tests grab the handles via jest.requireMock and configure
// them per-test. This avoids the timing trap of a factory closing over a
// top-level `let` (hoisted above the declaration -> undefined at call time).
jest.mock("@/lib/tools/catalog/catalog", () => ({
  toolCatalogInstance: {
    list: jest.fn(() => Promise.resolve([])),
    dispatch: jest.fn(() =>
      Promise.resolve({ ok: true, result: { content: [{ type: "text", text: "ok" }] } })
    ),
  },
}))

jest.mock("@/lib/mcp/connector-service", () => ({
  getConnectorTools: jest.fn(() => Promise.reject(new Error("not found"))),
}))

jest.mock("@/lib/logger", () => {
  const singleton = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { createLogger: () => singleton }
})

import { resolveAgentTools } from "@/lib/agents/tool-resolver"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"

const listMock = toolCatalogInstance.list as jest.Mock
const dispatchMock = toolCatalogInstance.dispatch as jest.Mock
// Grab the connector mock via requireMock (NOT a static import): statically
// importing connector-service would force jest to transform its real ESM import
// graph (@ai-sdk/mcp -> pkce-challenge) and throw. The resolver lazy-imports it,
// so the mock applies without the real module ever loading.
const getConnectorToolsMock = (
  jest.requireMock("@/lib/mcp/connector-service") as {
    getConnectorTools: jest.Mock
  }
).getConnectorTools

/** Narrow a resolved AI SDK tool to its executable shape for tests. */
function asExecutable(t: unknown): { execute: (args: unknown) => Promise<string> } {
  return t as unknown as { execute: (args: unknown) => Promise<string> }
}

function entry(overrides: Partial<ToolCatalogEntry>): ToolCatalogEntry {
  return {
    identifier: "decisions.search",
    version: "v1",
    name: "search_decisions",
    description: "Search decisions",
    inputSchema: { type: "object", properties: {} },
    surfaces: ["internal"],
    requiredScopes: ["mcp:search_decisions"],
    agentCallable: true,
    source: "code",
    isActive: true,
    ...overrides,
  }
}

const caller = {
  userId: 1,
  cognitoSub: "sub-1",
  scopes: ["mcp:search_decisions"],
  roleNames: ["staff"],
}

describe("resolveAgentTools", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([])
    dispatchMock
      .mockReset()
      .mockResolvedValue({ ok: true, result: { content: [{ type: "text", text: "ok" }] } })
    getConnectorToolsMock.mockReset().mockRejectedValue(new Error("not found"))
  })

  it("exposes only author-enabled tools that the catalog returns (intersection)", async () => {
    // Catalog (already scope+agentOnly filtered) returns one tool; the author
    // requested two — the second is denied.
    listMock.mockResolvedValue([entry({ identifier: "decisions.search", name: "search_decisions" })])
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search", "decisions.capture"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-1",
    })
    expect(resolved.grantedToolIdentifiers).toEqual(["decisions.search"])
    expect(resolved.deniedToolIdentifiers).toEqual(["decisions.capture"])
    expect(Object.keys(resolved.tools)).toEqual(["search_decisions"])
  })

  it("requests the catalog on the internal surface with agentOnly + caller scopes", async () => {
    await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-2",
    })
    expect(listMock).toHaveBeenCalledWith({
      surface: "internal",
      scopes: caller.scopes,
      agentOnly: true,
    })
  })

  it("fails closed: no enabled tools => empty tool set, no catalog call", async () => {
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: [],
      enabledConnectorIds: [],
      caller,
      requestId: "req-3",
    })
    expect(Object.keys(resolved.tools)).toHaveLength(0)
    expect(listMock).not.toHaveBeenCalled()
  })

  it("wrapped tool dispatches through the catalog and returns text", async () => {
    listMock.mockResolvedValue([entry({})])
    dispatchMock.mockResolvedValue({
      ok: true,
      result: { content: [{ type: "text", text: "hello world" }] },
    })
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-4",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({ query: "x" })
    expect(out).toContain("hello world")
    // Must dispatch on the 'internal' surface (#926) — the default 'mcp' would
    // reject internal-only tools and use the wrong scope.
    expect(dispatchMock).toHaveBeenCalledWith(
      "search_decisions",
      expect.any(Object),
      expect.any(Object),
      "internal"
    )
  })

  it("invokes the audit sink for each tool invocation", async () => {
    listMock.mockResolvedValue([entry({})])
    const audits: Array<{ ok: boolean; toolIdentifier: string }> = []
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-5",
      onToolInvocation: (e) => {
        audits.push({ ok: e.ok, toolIdentifier: e.toolIdentifier })
      },
    })
    await asExecutable(resolved.tools["search_decisions"]).execute({ query: "x" })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toEqual({ ok: true, toolIdentifier: "decisions.search" })
  })

  it("returns (not throws) a dispatch rejection so the model can recover", async () => {
    listMock.mockResolvedValue([entry({})])
    dispatchMock.mockResolvedValue({ ok: false, reason: "scope_denied" })
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-6",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})
    expect(out).toContain("scope_denied")
  })

  it("merges connector tools and records failed connector ids", async () => {
    listMock.mockResolvedValue([])
    getConnectorToolsMock.mockImplementation((serverId: string) =>
      serverId === "srv-ok"
        ? Promise.resolve({
            serverId: "srv-ok",
            serverName: "OK",
            tools: { remote_tool: { description: "remote" } },
            close: jest.fn(() => Promise.resolve()),
          })
        : Promise.reject(new Error("not found"))
    )
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: [],
      enabledConnectorIds: ["srv-ok", "srv-missing"],
      caller,
      requestId: "req-7",
    })
    expect(Object.keys(resolved.tools)).toContain("remote_tool")
    expect(resolved.connectorResults).toHaveLength(1)
    expect(resolved.failedConnectorIds).toEqual(["srv-missing"])
  })
})
