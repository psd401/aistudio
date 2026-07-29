let context:
  | {
      ownerEmail: string
      actorEmail: string
      mode: "owner" | "scheduled"
    }
  | null = {
  ownerEmail: "owner@psd401.net",
  actorEmail: "owner@psd401.net",
  mode: "owner",
}

const getSecretJsonMock = jest.fn()
const getSecretStringMock = jest.fn()
const storeAistudioOAuthTokensMock = jest.fn()
const deleteAistudioOAuthSecretMock = jest.fn()

jest.mock("@/lib/agent-workspace/invocation-context", () => ({
  verifyAgentInvocationContext: jest.fn(async () => context),
}))
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  aistudioOAuthSecretId: (ownerEmail: string) =>
    `psd-agent-creds/test/user/${ownerEmail}/aistudio_oauth`,
  deleteAistudioOAuthSecret: (...args: unknown[]) =>
    deleteAistudioOAuthSecretMock(...args),
  getSecretJson: (...args: unknown[]) => getSecretJsonMock(...args),
  getSecretString: (...args: unknown[]) => getSecretStringMock(...args),
  storeAistudioOAuthTokens: (...args: unknown[]) =>
    storeAistudioOAuthTokensMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "request-test",
  sanitizeForLogging: (value: unknown) => value,
}))

import type { NextRequest } from "next/server"
import { POST } from "@/app/api/agent/aistudio/route"

function request(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest
}

const originalFetch = globalThis.fetch
const originalAuthUrl = process.env.AUTH_URL

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  const serialized = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => serialized,
  } as unknown as Response
}

beforeEach(() => {
  context = {
    ownerEmail: "owner@psd401.net",
    actorEmail: "owner@psd401.net",
    mode: "owner",
  }
  process.env.APP_BASE_URL = "https://app.example"
  process.env.AUTH_URL = "https://app.example"
  process.env.ENVIRONMENT = "test"
  getSecretJsonMock.mockReset().mockResolvedValue(null)
  getSecretStringMock.mockReset().mockResolvedValue("personal-key")
  storeAistudioOAuthTokensMock.mockReset().mockResolvedValue(undefined)
  deleteAistudioOAuthSecretMock.mockReset().mockResolvedValue(true)
  globalThis.fetch = jest.fn(async () =>
    jsonResponse({
      jsonrpc: "2.0",
      id: "upstream",
      result: { ok: true },
    })
  ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalAuthUrl === undefined) {
    delete process.env.AUTH_URL
  } else {
    process.env.AUTH_URL = originalAuthUrl
  }
})

function definePOSTApiAgentAistudioSuite1Part1() {
  it("rejects missing context and model-supplied owner selectors", async () => {
    context = null
    expect(
      (await POST(request({ method: "tools/list", params: {} }))).status
    ).toBe(403)
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "owner@psd401.net",
      mode: "owner",
    }
    expect(
      (
        await POST(
          request({
            method: "tools/list",
            params: {},
            ownerEmail: "victim@psd401.net",
          })
        )
      ).status
    ).toBe(400)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
    expect(getSecretStringMock).not.toHaveBeenCalled()
  })

  it("derives the personal credential path from the signed owner", async () => {
    const response = await POST(
      request({
        method: "tools/call",
        params: { name: "describe_capabilities", arguments: {} },
      })
    )
    expect(response.status).toBe(200)
    expect(getSecretStringMock).toHaveBeenCalledWith(
      "psd-agent-creds/test/user/owner@psd401.net/aistudio_personal_key"
    )
    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(String(fetchCall[0])).toBe("https://app.example/api/mcp")
    expect(fetchCall[1].headers.Authorization).toBe("Bearer personal-key")
    expect(fetchCall[1].redirect).toBe("error")
    expect(JSON.stringify(await response.json())).not.toContain("personal-key")
  })

  it("falls back only to the fixed platform secret", async () => {
    getSecretStringMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("shared-key")
    const response = await POST(
      request({ method: "tools/list", params: {} })
    )
    expect(response.status).toBe(200)
    expect(getSecretStringMock).toHaveBeenNthCalledWith(
      2,
      "psd-agent/test/aistudio-mcp-api-key"
    )
    expect(await response.json()).toEqual(
      expect.objectContaining({ keySource: "shared", httpStatus: 200 })
    )
  })

  it("uses the signed owner's current OAuth access token without exposing it", async () => {
    getSecretJsonMock.mockResolvedValue({
      access_token: "owner-oauth-token",
      refresh_token: "owner-refresh-token",
      token_type: "Bearer",
      scope: "repositories:list",
      obtained_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    })

    const response = await POST(request({ method: "tools/list", params: {} }))

    expect(response.status).toBe(200)
    expect(getSecretJsonMock).toHaveBeenCalledWith(
      "psd-agent-creds/test/user/owner@psd401.net/aistudio_oauth"
    )
    expect(getSecretStringMock).not.toHaveBeenCalled()
    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(fetchCall[1].headers.Authorization).toBe(
      "Bearer owner-oauth-token"
    )
    const payload = await response.json()
    expect(payload).toEqual(
      expect.objectContaining({ keySource: "oauth", httpStatus: 200 })
    )
    expect(JSON.stringify(payload)).not.toContain("owner-oauth-token")
    expect(JSON.stringify(payload)).not.toContain("owner-refresh-token")
  })

  }

function definePOSTApiAgentAistudioSuite1Part2() {it("refreshes and persists a rotating OAuth grant before using it", async () => {
    getSecretJsonMock.mockResolvedValue({
      access_token: "expired-oauth-token",
      refresh_token: "old-refresh-token",
      token_type: "Bearer",
      scope: "repositories:list",
      obtained_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "fresh-oauth-token",
          refresh_token: "new-refresh-token",
          expires_in: 900,
          scope: "repositories:list repositories:search",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: "upstream",
          result: { ok: true },
        })
      ) as typeof fetch

    const response = await POST(request({ method: "tools/list", params: {} }))

    expect(response.status).toBe(200)
    const refreshCall = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(String(refreshCall[0])).toBe(
      "https://app.example/api/oauth/token"
    )
    expect(String(refreshCall[1].body)).toContain(
      "refresh_token=old-refresh-token"
    )
    expect(refreshCall[1].redirect).toBe("error")
    expect(storeAistudioOAuthTokensMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      expect.objectContaining({
        access_token: "fresh-oauth-token",
        refresh_token: "new-refresh-token",
      })
    )
    const mcpCall = (globalThis.fetch as jest.Mock).mock.calls[1]
    expect(mcpCall[1].headers.Authorization).toBe("Bearer fresh-oauth-token")
  })

  it("revokes and removes only the signed owner's OAuth grant", async () => {
    getSecretJsonMock.mockResolvedValue({
      access_token: "owner-oauth-token",
      refresh_token: "owner-refresh-token",
      token_type: "Bearer",
      scope: "repositories:list",
      obtained_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    })
    globalThis.fetch = jest.fn(async () => jsonResponse({})) as typeof fetch

    const response = await POST(request({ operation: "disconnect" }))

    expect(response.status).toBe(200)
    const responseBody = await response.json()
    expect(responseBody).toEqual({ disconnected: true })
    expect(getSecretJsonMock).toHaveBeenCalledWith(
      "psd-agent-creds/test/user/owner@psd401.net/aistudio_oauth"
    )
    const revokeCall = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(String(revokeCall[0])).toBe(
      "https://app.example/api/oauth/revocation"
    )
    expect(String(revokeCall[1].body)).toContain(
      "token=owner-refresh-token"
    )
    expect(deleteAistudioOAuthSecretMock).toHaveBeenCalledWith(
      "owner@psd401.net"
    )
    expect(JSON.stringify(responseBody)).not.toContain("owner-refresh-token")
  })

  it("rejects scheduled disconnects before reading the owner secret", async () => {
    context = {
      ownerEmail: "owner@psd401.net",
      actorEmail: "scheduler@psd401.net",
      mode: "scheduled",
    }

    const response = await POST(request({ operation: "disconnect" }))

    expect(response.status).toBe(403)
    expect(getSecretJsonMock).not.toHaveBeenCalled()
    expect(deleteAistudioOAuthSecretMock).not.toHaveBeenCalled()
  })

  it("rejects malformed tool calls before reading credentials", async () => {
    const response = await POST(
      request({
        method: "tools/call",
        params: {
          name: "../../admin",
          arguments: {},
        },
      })
    )
    expect(response.status).toBe(400)
    expect(getSecretStringMock).not.toHaveBeenCalled()
  })
}

const definePOSTApiAgentAistudioSuite1 = () => {
  definePOSTApiAgentAistudioSuite1Part1()
  definePOSTApiAgentAistudioSuite1Part2()
};

describe("POST /api/agent/aistudio", definePOSTApiAgentAistudioSuite1)
