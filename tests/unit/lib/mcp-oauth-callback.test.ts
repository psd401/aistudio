/** @jest-environment node */

import { beforeEach, describe, expect, it } from "@jest/globals"

const mockCookieGet = jest.fn()
const mockCookieGetAll = jest.fn()
const mockCookieDelete = jest.fn()
const mockDecryptToken = jest.fn<Promise<string>, [string]>()
const mockExecuteQuery = jest.fn()

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({
    get: mockCookieGet,
    getAll: mockCookieGetAll,
    delete: mockCookieDelete,
  })),
}))

jest.mock("@/lib/crypto/token-encryption", () => ({
  decryptToken: (value: string) => mockDecryptToken(value),
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (query: unknown, operation: string) =>
    mockExecuteQuery(query, operation),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "mcp-callback-test",
  startTimer: () => jest.fn(),
}))

jest.mock("@/lib/mcp/connector-service", () => ({
  getOAuthCredentials: jest.fn(),
  rejectUnsafeMcpUrl: jest.fn(),
}))

jest.mock("@/lib/mcp/mcp-oauth-provider", () => ({
  ServerSideOAuthProvider: jest.fn(),
}))

jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://aistudio.example.test",
}))

jest.mock("@/lib/security/safe-fetch", () => ({
  safeFetch: jest.fn(),
}))

import { GET } from "@/app/api/connectors/mcp-auth/callback/route"
import { parsePreRegisteredTokens } from "@/app/api/connectors/mcp-auth/callback/token-response"

describe("MCP OAuth callback token validation", () => {
  it("accepts a complete provider response and strips unknown fields", () => {
    expect(
      parsePreRegisteredTokens({
        access_token: "access",
        token_type: "bearer",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: "read write",
        unexpected: "ignored",
      })
    ).toEqual({
      access_token: "access",
      token_type: "bearer",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "read write",
    })
  })

  it("rejects missing or incorrectly typed required fields", () => {
    expect(parsePreRegisteredTokens(null)).toBeNull()
    expect(
      parsePreRegisteredTokens({
        access_token: "access",
        token_type: 42,
      })
    ).toBeNull()
  })
})

describe("MCP OAuth callback state boundary", () => {
  const serverId = "11111111-2222-4333-8444-555555555555"
  const state = `${serverId}:valid-nonce`

  beforeEach(() => {
    jest.clearAllMocks()
    mockCookieGet.mockReturnValue(undefined)
    mockCookieGetAll.mockReturnValue([])
  })

  it("rejects a provider error until a valid state cookie is found", async () => {
    const response = await GET(
      new Request(
        "https://aistudio.example.test/api/connectors/mcp-auth/callback?error=access_denied"
      )
    )

    expect(await response.text()).toContain("OAuth session expired")
    expect(mockCookieDelete).not.toHaveBeenCalled()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("consumes a validated state cookie before returning provider denial", async () => {
    mockCookieGet.mockReturnValue({ value: "encrypted-state" })
    mockDecryptToken.mockResolvedValue(
      JSON.stringify({
        codeVerifier: "v".repeat(43),
        serverId,
        userId: 7,
        createdAt: Date.now(),
        oauthState: state,
      })
    )

    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/connectors/mcp-auth/callback?state=${encodeURIComponent(state)}&error=access_denied`
      )
    )

    expect(await response.text()).toContain(
      "Authorization was denied by the provider."
    )
    expect(mockCookieDelete).toHaveBeenCalledWith({
      name: `mcp_auth_state_${serverId}`,
      path: "/api/connectors/mcp-auth",
    })
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })
})
