/** @jest-environment node */

const refreshAccessTokenMock = jest.fn()
const shouldRefreshTokenMock = jest.fn()
const syncCognitoRefreshMock = jest.fn()

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    auth: jest.fn(),
    handlers: {},
    signIn: jest.fn(),
    signOut: jest.fn(),
  })),
}))

jest.mock("next-auth/providers/cognito", () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}))

jest.mock("@/lib/auth/token-refresh-client", () => ({
  refreshAccessToken: (...args: unknown[]) =>
    refreshAccessTokenMock(...args),
  shouldRefreshToken: (...args: unknown[]) =>
    shouldRefreshTokenMock(...args),
}))

jest.mock("@/lib/auth/agent-token-sync", () => ({
  syncCognitoRefreshForAgent: (...args: unknown[]) =>
    syncCognitoRefreshMock(...args),
}))

jest.mock("@/lib/auth/edge-logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
}))

const { authConfig } = jest.requireActual("@/auth") as typeof import("@/auth")
const jwtCallback = authConfig.callbacks?.jwt

function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

function runJwt(input: Record<string, unknown>) {
  if (!jwtCallback) {
    throw new Error("JWT callback is not configured")
  }
  return jwtCallback({
    account: null,
    profile: undefined,
    session: undefined,
    token: {},
    trigger: undefined,
    user: { id: "user-1" },
    ...input,
  } as never)
}

describe("auth JWT lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    shouldRefreshTokenMock.mockReturnValue(false)
    syncCognitoRefreshMock.mockResolvedValue(undefined)
  })

  it("forces reauthentication for a session update trigger", async () => {
    await expect(runJwt({ trigger: "update" })).resolves.toBeNull()
    expect(refreshAccessTokenMock).not.toHaveBeenCalled()
  })

  it("creates the initial token from validated Cognito claims", async () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const expiresAt = issuedAt + 3600

    const token = await runJwt({
      account: {
        access_token: "access-1",
        expires_at: expiresAt,
        id_token: idToken({
          sub: "cognito-user-1",
          email: "user@example.com",
          given_name: "Ada",
          family_name: "Lovelace",
          iat: issuedAt,
        }),
        provider: "cognito",
        providerAccountId: "cognito-user-1",
        refresh_token: "refresh-1",
        type: "oidc",
      },
      profile: { email: "fallback@example.com" },
      user: { id: "user-1", email: "fallback@example.com" },
    })

    expect(token).toMatchObject({
      sub: "cognito-user-1",
      email: "user@example.com",
      name: "Ada",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: expiresAt * 1000,
      tokenLifetimeMs: 3_600_000,
    })
  })

  it("refreshes an existing token while preserving its lifetime metadata", async () => {
    shouldRefreshTokenMock.mockReturnValue(true)
    refreshAccessTokenMock.mockResolvedValue({
      accessToken: "access-2",
      expiresAt: Date.now() + 7_200_000,
      idToken: "id-2",
      refreshToken: "refresh-2",
    })

    const token = await runJwt({
      token: {
        accessToken: "access-1",
        email: "user@example.com",
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh-1",
        sub: "user-1",
        tokenLifetimeMs: 3_600_000,
      },
    })

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1)
    expect(token).toMatchObject({
      accessToken: "access-2",
      idToken: "id-2",
      refreshToken: "refresh-2",
      tokenLifetimeMs: 3_600_000,
    })
  })

  it("forces reauthentication when refresh is required but unavailable", async () => {
    shouldRefreshTokenMock.mockReturnValue(true)

    await expect(
      runJwt({
        token: {
          expiresAt: Date.now() + 3_600_000,
          sub: "user-1",
        },
      })
    ).resolves.toBeNull()
    expect(refreshAccessTokenMock).not.toHaveBeenCalled()
  })
})
