/**
 * Unit tests for lib/mcp/mcp-oauth-provider.ts — REV-COR-626.
 *
 * A corrupt/rotated-key refresh-token ciphertext must degrade gracefully: tokens()
 * still returns the (valid) access token and simply omits refresh_token, rather than
 * rejecting the whole promise and surfacing an unhandled decryption error to the
 * @ai-sdk/mcp auth flow. The access-token happy path is unchanged.
 */

// Singleton logger inside the factory (retrieved via createLogger() below) to avoid
// the TDZ an outer `const` mock hits when hoisted imports evaluate the SUT's
// module-level createLogger() first.
jest.mock("@/lib/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return { createLogger: () => logger }
})

jest.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ _eq: args }),
  and: (...args: unknown[]) => ({ _and: args }),
}))

jest.mock("@/lib/db/schema", () => ({
  nexusMcpServers: {},
  nexusMcpUserTokens: {
    userId: "user_id",
    serverId: "server_id",
  },
}))

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
}))

jest.mock("@/lib/crypto/token-encryption", () => ({
  encryptToken: jest.fn(),
  decryptToken: jest.fn(),
}))

import { ServerSideOAuthProvider } from "@/lib/mcp/mcp-oauth-provider"
import { executeQuery } from "@/lib/db/drizzle-client"
import { decryptToken } from "@/lib/crypto/token-encryption"
import { createLogger } from "@/lib/logger"

const executeQueryMock = executeQuery as jest.Mock
const decryptTokenMock = decryptToken as jest.Mock
// Same singleton the SUT's module-level logger uses, so its warn calls are observable.
const loggerWarn = (createLogger({}) as unknown as { warn: jest.Mock }).warn

function provider(): ServerSideOAuthProvider {
  return new ServerSideOAuthProvider({
    serverId: "srv-1",
    userId: 42,
    redirectUrl: "https://app.example.com/callback",
  })
}

/** A stored-token row with a non-expiring access token + refresh token. */
function tokenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    encryptedAccessToken: "ENC_ACCESS",
    encryptedRefreshToken: "ENC_REFRESH",
    tokenExpiresAt: null,
    scope: null,
    ...overrides,
  }
}

describe("ServerSideOAuthProvider.tokens() — refresh-token decrypt guard (REV-COR-626)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the access token and omits refresh_token when refresh decrypt fails", async () => {
    executeQueryMock.mockResolvedValueOnce([tokenRow()])
    decryptTokenMock.mockImplementation(async (ct: string) => {
      if (ct === "ENC_ACCESS") return "access-plain"
      throw new Error("bad refresh ciphertext")
    })

    const result = await provider().tokens()

    expect(result).toEqual({
      access_token: "access-plain",
      token_type: "bearer",
    })
    expect(result).not.toHaveProperty("refresh_token")
    expect(loggerWarn).toHaveBeenCalledWith(
      "Failed to decrypt stored refresh token — omitting from tokens",
      expect.objectContaining({ serverId: "srv-1", userId: 42 })
    )
  })

  it("does not reject when refresh decrypt throws", async () => {
    executeQueryMock.mockResolvedValueOnce([tokenRow()])
    decryptTokenMock.mockImplementation(async (ct: string) => {
      if (ct === "ENC_ACCESS") return "access-plain"
      throw new Error("bad refresh ciphertext")
    })

    await expect(provider().tokens()).resolves.toBeDefined()
  })

  it("returns refresh_token on the happy path (both decrypt)", async () => {
    executeQueryMock.mockResolvedValueOnce([tokenRow()])
    decryptTokenMock.mockImplementation(async (ct: string) =>
      ct === "ENC_ACCESS" ? "access-plain" : "refresh-plain"
    )

    const result = await provider().tokens()

    expect(result).toEqual({
      access_token: "access-plain",
      token_type: "bearer",
      refresh_token: "refresh-plain",
    })
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it("still rejects if the ACCESS token cannot be read (returns undefined, not throw)", async () => {
    // Access-token failure path is unchanged: it returns undefined (re-auth), and
    // never reaches the refresh-token branch.
    executeQueryMock.mockResolvedValueOnce([tokenRow()])
    decryptTokenMock.mockImplementation(async () => {
      throw new Error("bad access ciphertext")
    })

    const result = await provider().tokens()

    expect(result).toBeUndefined()
  })
})
