import { beforeEach, describe, expect, it, jest } from "@jest/globals"

const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("@/lib/content/helpers", () => ({
  systemUserIdOrNull: () => 1,
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  eq: jest.fn(),
  gt: jest.fn(),
  isNull: jest.fn(),
  or: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  oauthClients: {
    clientId: "client_id",
    clientName: "client_name",
    clientSecretHash: "client_secret_hash",
    redirectUris: "redirect_uris",
    grantTypes: "grant_types",
    responseTypes: "response_types",
    allowedScopes: "allowed_scopes",
    tokenEndpointAuthMethod: "token_endpoint_auth_method",
    isActive: "is_active",
  },
  oauthAuthorizationCodes: {
    id: "id",
    codeHash: "code_hash",
    userId: "user_id",
    clientId: "client_id",
    redirectUri: "redirect_uri",
    scopes: "scopes",
    codeChallenge: "code_challenge",
    codeChallengeMethod: "code_challenge_method",
    nonce: "nonce",
    adapterPayload: "adapter_payload",
    consumedAt: "consumed_at",
    grantId: "grant_id",
  },
  oauthAccessTokens: {
    id: "id",
    jti: "jti",
    userId: "user_id",
    clientId: "client_id",
    scopes: "scopes",
    adapterPayload: "adapter_payload",
    revokedAt: "revoked_at",
    grantId: "grant_id",
  },
  oauthRefreshTokens: {
    id: "id",
    tokenHash: "token_hash",
    userId: "user_id",
    clientId: "client_id",
    scopes: "scopes",
    adapterPayload: "adapter_payload",
    rotatedAt: "rotated_at",
    revokedAt: "revoked_at",
    grantId: "grant_id",
  },
  oauthProviderRecords: {
    model: "model",
    idHash: "id_hash",
    uid: "uid",
    grantId: "grant_id",
    adapterPayload: "adapter_payload",
    consumedAt: "consumed_at",
    expiresAt: "expires_at",
  },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DrizzleOidcAdapter } = require("@/lib/oauth/drizzle-adapter")

describe("Drizzle OIDC adapter production durability (#1285)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("persists and reloads provider records through the database across adapter instances", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          payload: {
            uid: "interaction-uid",
            accountId: "7",
            grantId: "grant-1",
          },
          consumedAt: null,
        },
      ])

    await DrizzleOidcAdapter("Interaction").upsert(
      "raw-interaction-id",
      {
        uid: "interaction-uid",
        accountId: "7",
        grantId: "grant-1",
      },
      600
    )
    const reloaded = await DrizzleOidcAdapter("Interaction").find(
      "raw-interaction-id"
    )

    expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
    expect(reloaded).toEqual(
      expect.objectContaining({
        uid: "interaction-uid",
        accountId: "7",
        grantId: "grant-1",
      })
    )
  })

  it("rehydrates provider payload fields needed by refresh rotation", async () => {
    const rotatedAt = new Date("2026-07-24T12:00:00.000Z")
    mockExecuteQuery.mockResolvedValueOnce([
      {
        userId: 7,
        clientId: "public-client",
        scopes: ["openid", "content:read"],
        adapterPayload: {
          grantId: "grant-1",
          gty: "authorization_code",
          sessionUid: "session-1",
          rotations: 0,
        },
        rotatedAt,
      },
    ])

    const token = await DrizzleOidcAdapter("RefreshToken").find("refresh-1")

    expect(token).toEqual(
      expect.objectContaining({
        accountId: "7",
        clientId: "public-client",
        grantId: "grant-1",
        sessionUid: "session-1",
        consumed: Math.floor(rotatedAt.getTime() / 1000),
      })
    )
  })

  it("atomically consumes authorization codes and refresh tokens", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([])

    await DrizzleOidcAdapter("AuthorizationCode").consume("code-1")
    await DrizzleOidcAdapter("RefreshToken").consume("refresh-1")
    await DrizzleOidcAdapter("RefreshToken").consume("refresh-1")

    expect(mockExecuteQuery).toHaveBeenCalledTimes(3)
  })
})
