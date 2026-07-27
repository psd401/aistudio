/** @jest-environment node */

const getUserOnlyMock = jest.fn()
const putMock = jest.fn()

jest.mock("@/lib/agent-credentials/broker", () => ({
  AgentCredentialBroker: class {
    getUserOnly(...args: unknown[]) {
      return getUserOnlyMock(...args)
    }
    put(...args: unknown[]) {
      return putMock(...args)
    }
  },
}))

import {
  executePlaudOperation,
  executePsdDataOperation,
} from "@/lib/agent-credentials/owner-operation-broker"

const originalFetch = globalThis.fetch

function jsonResponse(
  body: unknown,
  init: ResponseInit & { contentLength?: number } = {}
): Response {
  const text = JSON.stringify(body)
  const headerMap = new Map<string, string>([
    ["content-type", "application/json"],
    ...(init.contentLength !== undefined
      ? ([["content-length", String(init.contentLength)]] as const)
      : []),
    ...Object.entries(init.headers ?? {}),
  ])
  const bytes = new TextEncoder().encode(text)
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  } as unknown as Response
}

function emptyResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: null,
  } as unknown as Response
}

function sseResponse(data: unknown): Response {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  } as unknown as Response
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.PSD_DATA_MCP_URL = "https://data.example.test/mcp"
  getUserOnlyMock.mockResolvedValue({
    name: "plaud",
    value: JSON.stringify({
      refresh_token: "owner-refresh",
      client_id: "owner-client",
    }),
    scope: "user",
  })
  putMock.mockResolvedValue({ name: "plaud", action: "rotated" })
})

afterAll(() => {
  globalThis.fetch = originalFetch
  delete process.env.PSD_DATA_MCP_URL
})

function defineOwnerOnlyOperationCredentialBrokerSuite1Part1() {
  it("rejects destructive or newly introduced Plaud tools", async () => {
    const fetchMock = jest.fn()
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/call",
        toolName: "logout",
        toolArgs: {},
      })
    ).rejects.toThrow("Unsupported Plaud tool")
    expect(getUserOnlyMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed without an owner Plaud credential", async () => {
    getUserOnlyMock.mockResolvedValueOnce(null)
    const fetchMock = jest.fn()
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        toolName: undefined,
        toolArgs: {},
      })
    ).resolves.toEqual({
      status: "needs-auth",
      reason: "owner credential is unavailable",
    })
    expect(getUserOnlyMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      "plaud",
      { sessionId: "session-1" }
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends initialized notification before the Plaud tool operation", async () => {
    putMock.mockRejectedValueOnce(new Error("secrets unavailable"))
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse(
          {
            access_token: "ephemeral-access",
            refresh_token: "rotated-refresh",
          },
          { status: 200 }
        )
      }
      const message = JSON.parse(String(init?.body)) as {
        id?: string
        method: string
      }
      if (message.method === "notifications/initialized") {
        return emptyResponse(202)
      }
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: message.method === "tools/list" ? { tools: [] } : {},
        },
        {
          status: 200,
          ...(message.method === "initialize"
            ? { headers: { "mcp-session-id": "plaud-session" } }
            : {}),
        }
      )
    })
    globalThis.fetch = fetchMock as typeof fetch

    const result = await executePlaudOperation({
      ownerEmail: "owner@psd401.net",
      sessionId: "session-1",
      method: "tools/list",
      toolName: undefined,
      toolArgs: {},
    })
    expect(result).toEqual({ status: "ok", result: { tools: [] } })
    expect(putMock).toHaveBeenCalledTimes(1)
    const messages = fetchMock.mock.calls.slice(1).map((call) => {
      const init = call[1] as RequestInit
      return JSON.parse(String(init.body)) as { method: string }
    })
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ])
  })

  }

function defineOwnerOnlyOperationCredentialBrokerSuite1Part2() {it("rejects an oversized token response before parsing", async () => {
    globalThis.fetch = jest.fn().mockResolvedValueOnce(
      jsonResponse(
        { access_token: "attacker" },
        { status: 200, contentLength: 300_000 }
      )
    ) as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        toolName: undefined,
        toolArgs: {},
      })
    ).rejects.toThrow("response is too large")
  })

  it("rejects an oversized MCP response before buffering it", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "ephemeral-access" }, { status: 200 })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { jsonrpc: "2.0", result: {} },
          { status: 200, contentLength: 9 * 1024 * 1024 }
        )
      ) as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        toolName: undefined,
        toolArgs: {},
      })
    ).rejects.toThrow("response is too large")
  })

  it("rejects an oversized Plaud access token before sending it as a header", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      jsonResponse({ access_token: "a".repeat(16 * 1024 + 1) }, { status: 200 })
    )
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        toolName: undefined,
        toolArgs: {},
      })
    ).rejects.toThrow("access token is invalid")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects an oversized Plaud session id before forwarding it", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse({ access_token: "ephemeral-access" })
      }
      const message = JSON.parse(String(init?.body)) as {
        id: string
        method: string
      }
      return jsonResponse(
        { jsonrpc: "2.0", id: message.id, result: {} },
        { headers: { "mcp-session-id": "s".repeat(1025) } }
      )
    })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        toolName: undefined,
        toolArgs: {},
      })
    ).rejects.toThrow("session id is invalid")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  }

function defineOwnerOnlyOperationCredentialBrokerSuite1Part3() {it("does not accept an unrelated Plaud SSE JSON-RPC event", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse({ access_token: "ephemeral-access" })
      }
      const message = JSON.parse(String(init?.body)) as {
        id?: string
        method: string
      }
      if (message.method === "notifications/initialized") {
        return emptyResponse(202)
      }
      if (message.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: message.id, result: {} },
          { headers: { "mcp-session-id": "session-id" } }
        )
      }
      return sseResponse({
        jsonrpc: "2.0",
        id: "unrelated-request",
        result: { tools: [{ name: "wrong" }] },
      })
    })
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePlaudOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        toolName: undefined,
        toolArgs: {},
      })
    ).rejects.toThrow("did not match the request id")
  })

  it("never falls back when the owner's PSD credential is absent", async () => {
    getUserOnlyMock.mockResolvedValueOnce(null)
    const fetchMock = jest.fn()
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePsdDataOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        params: {},
      })
    ).resolves.toEqual({
      status: "needs-auth",
      reason: "owner credential is unavailable",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("accepts Cognito's application/x-amz-json-1.1 refresh response", async () => {
    getUserOnlyMock.mockResolvedValueOnce({
      name: "cognito-refresh",
      value: JSON.stringify({
        refresh_token: "owner-refresh",
        client_id: "owner-client",
      }),
      scope: "user",
    })
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { AuthenticationResult: { IdToken: "owner-id-token" } },
          { headers: { "content-type": "application/x-amz-json-1.1" } }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: "2.0", result: { tools: [] } })
      )
    globalThis.fetch = fetchMock as typeof fetch
    await expect(
      executePsdDataOperation({
        ownerEmail: "owner@psd401.net",
        sessionId: "session-1",
        method: "tools/list",
        params: {},
      })
    ).resolves.toEqual({ status: "ok", result: { tools: [] } })
  })

  }

const defineOwnerOnlyOperationCredentialBrokerSuite1 = () => {
  defineOwnerOnlyOperationCredentialBrokerSuite1Part1()
  defineOwnerOnlyOperationCredentialBrokerSuite1Part2()
  defineOwnerOnlyOperationCredentialBrokerSuite1Part3()
};

describe("owner-only operation credential broker", defineOwnerOnlyOperationCredentialBrokerSuite1)
