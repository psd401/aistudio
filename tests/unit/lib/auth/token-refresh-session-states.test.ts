/**
 * @jest-environment node
 *
 * The four session states from #1297, exercised against the real refresh stack
 * (`token-refresh-client` → `cognito-refresh` → `fetch`). Only the network call
 * is mocked.
 *
 *   1. Full-lifetime session          → no refresh attempted
 *   2. Proactive refresh window       → refreshes, session survives
 *   3. Expired access token           → refreshes, session survives
 *   4. Invalid/expired/revoked token  → fails closed (null → re-authenticate)
 *
 * Before the fix, states 2–4 all ended the same way: the Edge bundle tried to
 * `require("winston")` while loading the refresh implementation, threw
 * `TypeError: Native module not found: winston`, and the JWT callback returned
 * `null` — bouncing a perfectly valid session to sign-in.
 */
import type { JWT } from "next-auth/jwt"
import { refreshAccessToken, shouldRefreshToken } from "@/lib/auth/token-refresh-client"
import { __resetRefreshStateForTests } from "@/lib/auth/cognito-refresh"

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123"
const REFRESH_TOKEN = "r".repeat(64)
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000
const FRESH_ID_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ sub: "user-1" }),
).toString("base64url")}.signature`

// `@types/jest`'s `jest.Mock<TReturn, TArgs>` takes the RETURN type first and the
// argument tuple second — it is not `jest.Mock<TSignature>` (that form belongs to
// `@jest/globals`, which this file does not import). Passing a function type as
// TReturn makes `ResolvedValue<TReturn>` collapse to `never`, so every
// `mockResolvedValue(...)` fails to compile.
type FetchMock = jest.Mock<Promise<Response>, [url: string, init: RequestInit]>

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

/** A session token as the JWT callback sees it, `msUntilExpiry` from expiring. */
const sessionToken = (msUntilExpiry: number, sub = "user-1"): JWT =>
  ({
    sub,
    refreshToken: REFRESH_TOKEN,
    expiresAt: Date.now() + msUntilExpiry,
    tokenLifetimeMs: TWELVE_HOURS_MS,
  }) as unknown as JWT

describe("#1297 session states", () => {
  const OLD_ENV = { ...process.env }
  let fetchMock: FetchMock

  beforeEach(() => {
    __resetRefreshStateForTests()
    jest.spyOn(console, "warn").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
    process.env.AUTH_COGNITO_CLIENT_ID = "test-client-id"
    process.env.AUTH_COGNITO_ISSUER = ISSUER
    fetchMock = jest.fn() as unknown as FetchMock
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.env = { ...OLD_ENV }
  })

  it("state 1: a full-lifetime session is not refreshed", () => {
    // 12h token, 11h left — far outside the 25% (3h) proactive threshold.
    expect(shouldRefreshToken(sessionToken(11 * 60 * 60 * 1000))).toBe(false)
  })

  it("state 2: a session inside the proactive window refreshes and survives", async () => {
    // 2h left on a 12h token → inside the 25% threshold.
    const token = sessionToken(2 * 60 * 60 * 1000)
    expect(shouldRefreshToken(token)).toBe(true)

    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        AuthenticationResult: {
          AccessToken: "fresh-access",
          IdToken: FRESH_ID_TOKEN,
          ExpiresIn: 43200,
        },
      }),
    )

    const refreshed = await refreshAccessToken(token)
    expect(refreshed).not.toBeNull()
    expect(refreshed?.accessToken).toBe("fresh-access")
    expect(refreshed?.idToken).toBe(FRESH_ID_TOKEN)
    expect(refreshed?.expiresAt).toBeGreaterThan(Date.now())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("state 3: an already-expired access token refreshes on a still-valid refresh token", async () => {
    const token = sessionToken(-60 * 1000)
    expect(shouldRefreshToken(token)).toBe(true)

    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        AuthenticationResult: {
          AccessToken: "fresh-access",
          IdToken: FRESH_ID_TOKEN,
          ExpiresIn: 43200,
        },
      }),
    )

    const refreshed = await refreshAccessToken(token)
    expect(refreshed?.accessToken).toBe("fresh-access")
    // Cognito does not rotate on REFRESH_TOKEN_AUTH — the session keeps the
    // refresh token it already had.
    expect(refreshed?.refreshToken).toBe(REFRESH_TOKEN)
  })

  it("state 4: a revoked refresh token fails closed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        __type: "NotAuthorizedException",
        message: "Refresh Token has been revoked",
      }),
    )

    await expect(refreshAccessToken(sessionToken(-60 * 1000))).resolves.toBeNull()
  })

  it("state 4: an expired refresh token fails closed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { __type: "NotAuthorizedException", message: "Refresh Token has expired" }),
    )

    await expect(refreshAccessToken(sessionToken(2 * 60 * 60 * 1000))).resolves.toBeNull()
  })

  it("fails closed without a network call when the token carries no refresh token", async () => {
    const token = { sub: "user-1", expiresAt: Date.now() } as unknown as JWT
    await expect(refreshAccessToken(token)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed on a malformed token object", async () => {
    await expect(refreshAccessToken(null as unknown as JWT)).resolves.toBeNull()
    await expect(refreshAccessToken({} as unknown as JWT)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed — never throws — when the transport blows up", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"))
    await expect(refreshAccessToken(sessionToken(-1000))).resolves.toBeNull()
  })

  it("redacts the refresh token even when an upstream error echoes it back", async () => {
    const warnSpy = jest.spyOn(console, "warn")
    const errorSpy = jest.spyOn(console, "error")
    // Inject the token into the failure so the assertion exercises redaction
    // rather than passing because the token was never a candidate for logging.
    fetchMock.mockRejectedValue(new Error(`upstream said ${REFRESH_TOKEN}`))

    await refreshAccessToken(sessionToken(-1000))

    const emitted = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n")
    expect(emitted).not.toContain(REFRESH_TOKEN)
    expect(emitted).toContain("[REDACTED_TOKEN]")
  })
})
