/** @jest-environment node */

import { beforeEach, describe, expect, it } from "@jest/globals"

const mockCookieGet = jest.fn()
const mockCookieDelete = jest.fn()
const mockDecryptToken = jest.fn<Promise<string>, [string]>()
const mockExecuteQuery = jest.fn()

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({
    get: mockCookieGet,
    delete: mockCookieDelete,
  })),
}))

jest.mock("@/lib/crypto/token-encryption", () => ({
  decryptToken: (value: string) => mockDecryptToken(value),
  encryptToken: jest.fn(),
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
  generateRequestId: () => "oauth-callback-test",
  startTimer: () => jest.fn(),
}))

jest.mock("@/lib/mcp/connector-service", () => ({
  loadOAuthCredentials: jest.fn(),
  rejectUnsafeMcpUrl: jest.fn(),
}))

jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://aistudio.example.test",
}))

jest.mock("@/lib/security/safe-fetch", () => ({
  safeFetch: jest.fn(),
}))

import { GET } from "@/app/api/connectors/oauth/callback/route"
import { parseTokenResponse } from "@/app/api/connectors/oauth/callback/token-response"

describe("OAuth callback token validation", () => {
  it("normalizes provider expiry strings", () => {
    expect(
      parseTokenResponse({
        access_token: "access",
        token_type: "bearer",
        expires_in: "3600",
      })
    ).toEqual({
      access_token: "access",
      token_type: "bearer",
      expires_in: 3600,
    })
  })

  it("rejects malformed provider responses", () => {
    expect(() =>
      parseTokenResponse({
        access_token: "access",
        token_type: 42,
      })
    ).toThrow()
  })
})

describe("OAuth callback state boundary", () => {
  const serverId = "11111111-2222-4333-8444-555555555555"
  const state = `${serverId}:valid-nonce`

  beforeEach(() => {
    jest.clearAllMocks()
    mockCookieGet.mockReturnValue(undefined)
  })

  it("does not honor a provider error without a valid state cookie", async () => {
    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/connectors/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`
      )
    )

    expect(await response.text()).toContain("OAuth session expired")
    expect(mockCookieDelete).not.toHaveBeenCalled()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("rejects a mismatched state without consuming the cookie", async () => {
    mockCookieGet.mockReturnValue({ value: "encrypted-state" })
    mockDecryptToken.mockResolvedValue(
      JSON.stringify({
        state,
        codeVerifier: "v".repeat(43),
        serverId,
        userId: 7,
        createdAt: Date.now(),
      })
    )

    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/connectors/oauth/callback?state=${serverId}:attacker&error=access_denied`
      )
    )

    expect(await response.text()).toContain("Invalid OAuth state")
    expect(mockCookieDelete).not.toHaveBeenCalled()
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })

  it("consumes a validated state cookie before returning provider denial", async () => {
    mockCookieGet.mockReturnValue({ value: "encrypted-state" })
    mockDecryptToken.mockResolvedValue(
      JSON.stringify({
        state,
        codeVerifier: "v".repeat(43),
        serverId,
        userId: 7,
        createdAt: Date.now(),
      })
    )

    const response = await GET(
      new Request(
        `https://aistudio.example.test/api/connectors/oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`
      )
    )

    expect(await response.text()).toContain(
      "Authorization was denied by the provider."
    )
    expect(mockCookieDelete).toHaveBeenCalledWith({
      name: `mcp_oauth_state_${serverId}`,
      path: "/api/connectors/oauth",
    })
    expect(mockExecuteQuery).not.toHaveBeenCalled()
  })
})
