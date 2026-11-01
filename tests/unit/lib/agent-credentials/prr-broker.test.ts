/** @jest-environment node */

/**
 * The PSD Public Records (PRR) MCP broker operation.
 *
 * Each staff member's PSD Agent reaches https://prr.psd401.net/mcp with that
 * staff member's OWN personal access token (`prr_pat_…`), stored by the
 * one-time credential-entry link in the owner-scoped broker slot `prr_pat`.
 * The token never reaches the model: the agent asks for a tool by name, the
 * web tier reads the slot, speaks Streamable HTTP, and returns only the MCP
 * result. These tests pin the boundary: which methods and tools are reachable,
 * how the token is sent, and how a missing or rejected token surfaces.
 */

const getUserOnly = jest.fn()

jest.mock("@/lib/agent-credentials/broker", () => {
  class AgentCredentialInputError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "AgentCredentialInputError"
    }
  }
  return {
    AgentCredentialBroker: jest.fn().mockImplementation(() => ({ getUserOnly })),
    AgentCredentialInputError,
  }
})

import {
  PRR_ALLOWED_TOOLS,
  executePrrOperation,
} from "@/lib/agent-credentials/owner-operation-broker"

const OWNER = { ownerEmail: "owner@psd401.net", sessionId: "sess-1" }
const TOKEN = "prr_pat_abc123_s3cr3tvalue"

const ELEVEN_TOOLS = [
  "psd_prr_requests_list",
  "psd_prr_request_get",
  "psd_prr_overdue_requests_list",
  "psd_prr_collection_tasks_list",
  "psd_prr_record_systems_list",
  "psd_prr_exemptions_list",
  "psd_prr_audit_log_search",
  "psd_prr_capabilities_list",
  "psd_prr_clarification_letter_draft",
  "psd_prr_collection_task_notes_propose",
  "psd_prr_exemption_citations_suggest",
]

/**
 * A minimal Response with a real ReadableStream body. This jest environment's
 * Response polyfill has no `body.getReader()`, which the broker's bounded
 * reader needs (same approach as agent-owner-operation-broker.test.ts).
 */
function mkResponse(
  status: number,
  body = "",
  headers: Record<string, string> = {}
): Response {
  const headerMap = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  )
  const bytes = new TextEncoder().encode(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    body: body
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        })
      : null,
  } as unknown as Response
}

type Message = { id?: string; method: string; params?: Record<string, unknown> }
type Call = { url: string; init: RequestInit; message: Message }

let calls: Call[]
/** Status the PRR server returns for a given JSON-RPC method. */
let statusFor: Record<string, number>

function prrServer(result: (message: Message) => unknown) {
  return jest.fn(async (url: unknown, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body)) as Message
    calls.push({ url: String(url), init: init ?? {}, message })
    const status = statusFor[message.method] ?? 200
    if (status !== 200) return mkResponse(status, "{}", { "content-type": "application/json" })
    if (message.method === "notifications/initialized") return mkResponse(202)
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: result(message) })
    if (message.method === "initialize") {
      return mkResponse(200, body, {
        "content-type": "application/json",
        "mcp-session-id": "prr-session-1",
      })
    }
    // PRR answers tool calls as SSE, the way Streamable HTTP servers may.
    return mkResponse(200, `event: message\ndata: ${body}\n\n`, {
      "content-type": "text/event-stream",
    })
  })
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name]
}

beforeEach(() => {
  calls = []
  statusFor = {}
  delete process.env.PRR_MCP_URL
  getUserOnly.mockReset().mockResolvedValue({
    name: "prr_pat",
    value: TOKEN,
    scope: "user",
  })
  global.fetch = prrServer((message) =>
    message.method === "tools/list"
      ? { tools: ELEVEN_TOOLS.map((name) => ({ name })) }
      : { content: [{ type: "text", text: '{"total":3,"scan_complete":true}' }] }
  ) as unknown as typeof fetch
})

describe("PRR broker allowlist", () => {
  it("allows exactly the eleven psd_prr_* tools", () => {
    expect([...PRR_ALLOWED_TOOLS].sort()).toEqual([...ELEVEN_TOOLS].sort())
  })

  it.each([
    ["an unknown tool", "tools/call", "psd_prr_request_close"],
    ["a non-PRR tool", "tools/call", "list_files"],
    ["a missing tool name", "tools/call", undefined],
    ["a non-tool method", "resources/list", undefined],
    ["initialize from the model", "initialize", undefined],
  ])("rejects %s before reading the token", async (_label, method, toolName) => {
    await expect(
      executePrrOperation({ ...OWNER, method, toolName, toolArgs: {} })
    ).rejects.toThrow(/Unsupported PRR/)
    expect(getUserOnly).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe("PRR token handling", () => {
  it("reports a missing token as needs-auth without calling PRR", async () => {
    getUserOnly.mockResolvedValueOnce(null)
    await expect(
      executePrrOperation({ ...OWNER, method: "tools/list", toolName: undefined, toolArgs: {} })
    ).resolves.toEqual({
      status: "needs-auth",
      reason: "PRR personal access token is not stored",
      code: "prr_token_missing",
    })
    expect(getUserOnly).toHaveBeenCalledWith("owner@psd401.net", "prr_pat", {
      sessionId: "sess-1",
    })
    expect(calls).toHaveLength(0)
  })

  it.each([
    ["no prr_pat_ prefix", "ghp_notaprrtoken123"],
    ["an embedded newline", "prr_pat_abc\nInjected: yes"],
    ["an embedded space", "prr_pat_abc def"],
  ])("treats a stored value with %s as rejected, never sending it", async (_label, value) => {
    getUserOnly.mockResolvedValueOnce({ name: "prr_pat", value, scope: "user" })
    const result = await executePrrOperation({
      ...OWNER,
      method: "tools/list",
      toolName: undefined,
      toolArgs: {},
    })
    expect(result).toMatchObject({ status: "needs-auth", code: "prr_token_rejected" })
    expect(JSON.stringify(result)).not.toContain(value)
    expect(calls).toHaveLength(0)
  })

  it("trims surrounding whitespace a user pasted with the token", async () => {
    getUserOnly.mockResolvedValueOnce({ name: "prr_pat", value: `  ${TOKEN}\n`, scope: "user" })
    await executePrrOperation({ ...OWNER, method: "tools/list", toolName: undefined, toolArgs: {} })
    expect(header(calls[0].init, "Authorization")).toBe(`Token ${TOKEN}`)
  })

  it.each(["initialize", "tools/call"])(
    "maps a PRR 401 on %s to needs-auth (expired or revoked token)",
    async (method) => {
      statusFor[method] = 401
      const result = await executePrrOperation({
        ...OWNER,
        method: "tools/call",
        toolName: "psd_prr_overdue_requests_list",
        toolArgs: {},
      })
      expect(result).toEqual({
        status: "needs-auth",
        reason: "PRR rejected the personal access token (missing, expired, or revoked)",
        code: "prr_token_rejected",
      })
    }
  )

  it.each([
    [403, { status: "forbidden" }],
    [429, { status: "rate-limited" }],
  ])("maps a PRR %s on the handshake like the same status on a call", async (status, expected) => {
    statusFor.initialize = status
    await expect(
      executePrrOperation({ ...OWNER, method: "tools/list", toolName: undefined, toolArgs: {} })
    ).resolves.toMatchObject(expected)
    expect(calls.map((call) => call.message.method)).toEqual(["initialize"])
  })

  it("maps a PRR 403 to forbidden and a 429 to rate-limited", async () => {
    statusFor["tools/call"] = 403
    await expect(
      executePrrOperation({ ...OWNER, method: "tools/call", toolName: "psd_prr_audit_log_search", toolArgs: {} })
    ).resolves.toMatchObject({ status: "forbidden" })
    statusFor["tools/call"] = 429
    await expect(
      executePrrOperation({ ...OWNER, method: "tools/call", toolName: "psd_prr_audit_log_search", toolArgs: {} })
    ).resolves.toEqual({ status: "rate-limited" })
  })
})

describe("PRR Streamable HTTP session", () => {
  it("initializes, acknowledges, then lists tools with the session id", async () => {
    const result = await executePrrOperation({
      ...OWNER,
      method: "tools/list",
      toolName: undefined,
      toolArgs: {},
    })

    expect(result).toEqual({
      status: "ok",
      result: { tools: ELEVEN_TOOLS.map((name) => ({ name })) },
    })
    expect(calls.map((call) => call.message.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
    for (const call of calls) {
      expect(call.url).toBe("https://prr.psd401.net/mcp")
      expect(header(call.init, "Authorization")).toBe(`Token ${TOKEN}`)
      expect(call.init.redirect).toBe("error")
      expect(call.init.signal).toBeDefined()
    }
    expect(header(calls[0].init, "Mcp-Session-Id")).toBeUndefined()
    expect(header(calls[1].init, "Mcp-Session-Id")).toBe("prr-session-1")
    expect(header(calls[2].init, "Mcp-Session-Id")).toBe("prr-session-1")
  })

  it.each(ELEVEN_TOOLS)("calls %s with the model's arguments", async (toolName) => {
    const result = await executePrrOperation({
      ...OWNER,
      method: "tools/call",
      toolName,
      toolArgs: { limit: 5 },
    })
    expect(result).toEqual({
      status: "ok",
      result: { content: [{ type: "text", text: '{"total":3,"scan_complete":true}' }] },
    })
    expect(calls[2].message).toMatchObject({
      method: "tools/call",
      params: { name: toolName, arguments: { limit: 5 } },
    })
  })

  it("never returns the token in a result", async () => {
    const result = await executePrrOperation({
      ...OWNER,
      method: "tools/call",
      toolName: "psd_prr_requests_list",
      toolArgs: {},
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it("honors PRR_MCP_URL and refuses a non-HTTPS endpoint", async () => {
    process.env.PRR_MCP_URL = "https://prr-staging.psd401.net/mcp"
    await executePrrOperation({ ...OWNER, method: "tools/list", toolName: undefined, toolArgs: {} })
    expect(calls[0].url).toBe("https://prr-staging.psd401.net/mcp")

    calls = []
    process.env.PRR_MCP_URL = "http://prr.psd401.net/mcp"
    await expect(
      executePrrOperation({ ...OWNER, method: "tools/list", toolName: undefined, toolArgs: {} })
    ).rejects.toThrow("HTTPS")
    expect(calls).toHaveLength(0)
  })
})
