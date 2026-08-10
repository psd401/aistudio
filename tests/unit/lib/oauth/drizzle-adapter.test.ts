import { beforeEach, describe, expect, it, jest } from "@jest/globals"

const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("@/lib/content/helpers", () => ({
  systemUserIdOrNull: () => 1,
}))

// One shared logger so tests can assert on what was actually logged. The
// previous mock built a fresh object per createLogger() call, so nothing could
// reach the spies — which is why the missing redirect detail in the
// security-validation error went unnoticed until it cost a prod outage.
const mockLogError = jest.fn()
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
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
    applicationType: "application_type",
    clientSecretHash: "client_secret_hash",
    redirectUris: "redirect_uris",
    grantTypes: "grant_types",
    responseTypes: "response_types",
    allowedScopes: "allowed_scopes",
    tokenEndpointAuthMethod: "token_endpoint_auth_method",
    requirePkce: "require_pkce",
    isActive: "is_active",
    isFirstParty: "is_first_party",
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

  it("maps a validated native registration to oidc-provider native metadata", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      {
        clientId: "native-client",
        clientName: "Native client",
        applicationType: "native",
        clientSecretHash: null,
        redirectUris: ["http://127.0.0.1/oauth/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        allowedScopes: ["openid", "content:read"],
        tokenEndpointAuthMethod: "none",
        requirePkce: true,
        isFirstParty: true,
      },
    ])

    const client = await DrizzleOidcAdapter("Client").find("native-client")

    expect(client).toEqual(
      expect.objectContaining({
        application_type: "native",
        client_secret: undefined,
        redirect_uris: ["http://127.0.0.1/oauth/callback"],
        token_endpoint_auth_method: "none",
        is_first_party: true,
      })
    )
  })

  it("fails closed when stored public-client metadata violates security policy", async () => {
    mockExecuteQuery.mockResolvedValueOnce([
      {
        clientId: "unsafe-native",
        clientName: "Unsafe native client",
        applicationType: "native",
        clientSecretHash: "must-not-exist",
        redirectUris: ["http://localhost/oauth/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        allowedScopes: ["openid"],
        tokenEndpointAuthMethod: "client_secret_post",
        requirePkce: false,
        isFirstParty: false,
      },
    ])

    await expect(
      DrizzleOidcAdapter("Client").find("unsafe-native")
    ).resolves.toBeUndefined()
  })
})

describe("OAuth client redirect diagnostics", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("names the offending redirect URI when one bad entry disables a client", async () => {
    // Reproduces the prod `PSD OpenClaw` client as it stood on 2026-08-10: two
    // perfectly valid production URIs plus one dev-only `http://localhost:3000`
    // entry. `localhost` is not a literal loopback IP, so the native policy
    // rejects it (RFC 8252), and because validation is all-or-nothing the whole
    // client failed to load — every user got `invalid_client` on agent-connect.
    //
    // The log said only `redirectErrorCount: 1`, which is indistinguishable
    // from a missing or disabled client. The error must name the URI so this is
    // diagnosable from the log group alone.
    mockExecuteQuery.mockResolvedValueOnce([
      {
        clientId: "openclaw-client",
        clientName: "PSD OpenClaw",
        applicationType: "native",
        clientSecretHash: null,
        redirectUris: [
          "http://localhost:3000/agent-connect-aistudio/callback",
          "https://aistudio.psd401.ai/agent-connect-aistudio/callback",
        ],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        allowedScopes: ["openid", "platform:read"],
        tokenEndpointAuthMethod: "none",
        requirePkce: true,
        isFirstParty: true,
      },
    ])

    const client = await DrizzleOidcAdapter("Client").find("openclaw-client")

    expect(client).toBeUndefined()
    expect(mockLogError).toHaveBeenCalledWith(
      "OAuth client registration failed security validation",
      expect.objectContaining({
        clientId: "openclaw-client",
        redirectErrorCount: 1,
        redirectErrors: [
          expect.stringContaining(
            "http://localhost:3000/agent-connect-aistudio/callback"
          ),
        ],
      })
    )
    // The valid production URI must not be blamed.
    const logged = mockLogError.mock.calls.at(-1) as [string, { redirectErrors: string[] }]
    expect(logged[1].redirectErrors.join(" ")).not.toContain(
      "https://aistudio.psd401.ai"
    )
  })
})
