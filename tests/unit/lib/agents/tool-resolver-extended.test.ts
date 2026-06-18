// NOTE: do NOT import `jest` from "@jest/globals" — doing so disables jest.mock
// hoisting and breaks all mocks. Use the global `jest`.
import { describe, it, expect, beforeEach } from "@jest/globals"
import type { ToolCatalogEntry } from "@/lib/tools/catalog/types"

// ── Mocks ────────────────────────────────────────────────────────────────────
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
  const singleton = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { createLogger: () => singleton }
})

import { resolveAgentTools } from "@/lib/agents/tool-resolver"
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog"

const listMock = toolCatalogInstance.list as jest.Mock
const dispatchMock = toolCatalogInstance.dispatch as jest.Mock

/** Narrow resolved AI SDK tool to its executable shape for tests. */
function asExecutable(t: unknown): { execute: (args: unknown) => Promise<string> } {
  return t as unknown as { execute: (args: unknown) => Promise<string> }
}

function entry(overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return {
    identifier: "decisions.search",
    version: "v1",
    name: "search_decisions",
    description: "Search decisions",
    inputSchema: { type: "object", properties: {} },
    surfaces: ["internal"],
    requiredScopes: ["mcp:search_decisions"],
    agentCallable: true,
    destructive: false,
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

describe("tool-resolver: flattenMcpResult truncation", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([entry()])
    dispatchMock.mockReset()
  })

  it("truncates result text over 100,000 chars and appends ellipsis marker", async () => {
    const longText = "x".repeat(200_000)
    dispatchMock.mockResolvedValue({
      ok: true,
      result: { content: [{ type: "text", text: longText }] },
    })

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-trunc",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})

    expect(out.length).toBeLessThan(200_000)
    expect(out).toContain("…[truncated]")
  })

  it("does not truncate result text at exactly 100,000 chars", async () => {
    const exactText = "y".repeat(100_000)
    dispatchMock.mockResolvedValue({
      ok: true,
      result: { content: [{ type: "text", text: exactText }] },
    })

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-exact",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})

    expect(out).not.toContain("…[truncated]")
    expect(out.length).toBe(100_000)
  })
})

describe("tool-resolver: non-text MCP content summarization", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([entry()])
    dispatchMock.mockReset()
  })

  it("summarizes image content items as [image <mimeType>]", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      result: {
        content: [{ type: "image", mimeType: "image/png" }],
        isError: false,
      },
    })

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-img",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})
    expect(out).toBe("[image image/png]")
  })

  it("summarizes image without mimeType as [image]", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      result: {
        content: [{ type: "image" }],
        isError: false,
      },
    })

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-img-no-mime",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})
    expect(out).toBe("[image]")
  })

  it("summarizes resource content items as [resource <mimeType>]", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      result: {
        content: [{ type: "resource", mimeType: "application/pdf" }],
        isError: false,
      },
    })

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-res",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})
    expect(out).toBe("[resource application/pdf]")
  })

  it("concatenates mixed text + image + resource content parts with newlines", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      result: {
        content: [
          { type: "text", text: "here is the chart" },
          { type: "image", mimeType: "image/jpeg" },
          { type: "text", text: "end" },
        ],
        isError: false,
      },
    })

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-mixed",
    })
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})
    expect(out).toBe("here is the chart\n[image image/jpeg]\nend")
  })
})

describe("tool-resolver: boundAuditArgs bounding", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([entry()])
    dispatchMock.mockReset().mockResolvedValue({
      ok: true,
      result: { content: [{ type: "text", text: "done" }] },
    })
  })

  it("captures args as-is when they fit under 4,000 serialized chars", async () => {
    const audits: Array<{ args: Record<string, unknown> }> = []

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-args-small",
      onToolInvocation: (e) => { audits.push({ args: e.args }) },
    })
    await asExecutable(resolved.tools["search_decisions"]).execute({ query: "short" })

    expect(audits).toHaveLength(1)
    expect(audits[0].args).toEqual({ query: "short" })
    expect((audits[0].args as Record<string, unknown>).__truncated).toBeUndefined()
  })

  it("replaces oversized args with __truncated sentinel in the audit event", async () => {
    const audits: Array<{ args: Record<string, unknown> }> = []
    const bigArg = { data: "z".repeat(5_000) }

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-args-big",
      onToolInvocation: (e) => { audits.push({ args: e.args }) },
    })
    await asExecutable(resolved.tools["search_decisions"]).execute(bigArg)

    expect(audits).toHaveLength(1)
    expect(audits[0].args.__truncated).toBe(true)
    expect(typeof audits[0].args.preview).toBe("string")
  })
})

describe("tool-resolver: audit sink failure does not break the model loop", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([entry()])
    dispatchMock.mockReset().mockResolvedValue({
      ok: true,
      result: { content: [{ type: "text", text: "tool result" }] },
    })
  })

  it("returns tool result even when the audit sink throws synchronously", async () => {
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-audit-throw",
      onToolInvocation: () => {
        throw new Error("audit DB down")
      },
    })

    // Must not throw — the model loop must continue
    await expect(
      asExecutable(resolved.tools["search_decisions"]).execute({ query: "x" })
    ).resolves.toContain("tool result")
  })

  it("returns tool result even when the audit sink rejects asynchronously", async () => {
    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-audit-reject",
      onToolInvocation: async () => {
        throw new Error("audit timeout")
      },
    })

    await expect(
      asExecutable(resolved.tools["search_decisions"]).execute({ query: "y" })
    ).resolves.toContain("tool result")
  })
})

describe("tool-resolver: dispatch exception handling", () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([entry()])
    dispatchMock.mockReset()
  })

  it("returns an error string (does not throw) when dispatch throws", async () => {
    dispatchMock.mockRejectedValue(new Error("upstream crashed"))

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-throw",
    })

    // execute() resolving (not rejecting) is itself the "does not throw" guarantee.
    // Assert it returns a string carrying the error text — the previous
    // `expect(out).not.toThrow` was a no-op (it just accessed a matcher property).
    const out = await asExecutable(resolved.tools["search_decisions"]).execute({})
    expect(typeof out).toBe("string")
    expect(out).toContain("upstream crashed")
  })

  it("records ok=false and the error message in the audit when dispatch throws", async () => {
    dispatchMock.mockRejectedValue(new Error("dispatch error"))
    const audits: Array<{ ok: boolean; error: string | undefined }> = []

    const resolved = await resolveAgentTools({
      enabledToolIdentifiers: ["decisions.search"],
      enabledConnectorIds: [],
      caller,
      requestId: "req-throw-audit",
      onToolInvocation: (e) => { audits.push({ ok: e.ok, error: e.error }) },
    })
    await asExecutable(resolved.tools["search_decisions"]).execute({})

    expect(audits).toHaveLength(1)
    expect(audits[0].ok).toBe(false)
    expect(audits[0].error).toContain("dispatch error")
  })
})
