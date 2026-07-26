/**
 * @jest-environment node
 *
 * Edge-safe Cognito refresh exchange (#1297).
 *
 * The previous implementation reached for a `"use server"` action from the Edge
 * middleware graph, which inlined `@/lib/logger` → `winston` and made every
 * refresh throw `TypeError: Native module not found: winston`. This module does
 * the exchange with `fetch` only. These tests pin the wire contract, the
 * fail-closed classification, and the rate-limit/dedup behaviour carried over
 * from the retired action.
 */
import {
  classifyInitiateAuthError,
  refreshCognitoTokens,
  resolveCognitoIdpEndpoint,
  __resetRefreshStateForTests,
} from "@/lib/auth/cognito-refresh"

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123"
const VALID_REFRESH_TOKEN = "a".repeat(64)

type FetchMock = jest.Mock<(url: string, init: RequestInit) => Promise<Response>>

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

describe("resolveCognitoIdpEndpoint", () => {
  it("derives the regional endpoint from the issuer origin", () => {
    expect(resolveCognitoIdpEndpoint(ISSUER)).toBe("https://cognito-idp.us-east-1.amazonaws.com/")
  })

  it("accepts the FIPS endpoint variant", () => {
    expect(
      resolveCognitoIdpEndpoint("https://cognito-idp-fips.us-east-1.amazonaws.com/us-east-1_abc"),
    ).toBe("https://cognito-idp-fips.us-east-1.amazonaws.com/")
  })

  it("rejects a lookalike host that merely starts with the Cognito prefix", () => {
    expect(
      resolveCognitoIdpEndpoint("https://cognito-idp.us-east-1.amazonaws.com.evil.test/pool"),
    ).toBeNull()
  })

  it("rejects a non-https issuer", () => {
    expect(resolveCognitoIdpEndpoint("http://cognito-idp.us-east-1.amazonaws.com/pool")).toBeNull()
  })

  it("preserves a non-commercial partition carried by the issuer", () => {
    expect(
      resolveCognitoIdpEndpoint("https://cognito-idp.cn-north-1.amazonaws.com.cn/cn-north-1_x"),
    ).toBe("https://cognito-idp.cn-north-1.amazonaws.com.cn/")
  })

  it("falls back to an explicit region when the issuer is unusable", () => {
    expect(resolveCognitoIdpEndpoint(undefined, "us-west-2")).toBe(
      "https://cognito-idp.us-west-2.amazonaws.com/",
    )
    expect(resolveCognitoIdpEndpoint("not-a-url", "us-west-2")).toBe(
      "https://cognito-idp.us-west-2.amazonaws.com/",
    )
  })

  it("refuses a non-Cognito issuer host rather than posting a refresh token to it", () => {
    expect(resolveCognitoIdpEndpoint("https://evil.example.com/pool")).toBeNull()
  })

  it("refuses a region that is not shaped like an AWS region", () => {
    expect(resolveCognitoIdpEndpoint(undefined, "evil.example.com")).toBeNull()
    expect(resolveCognitoIdpEndpoint(undefined, "")).toBeNull()
  })

  it("returns null when nothing is configured (fail closed, never guess)", () => {
    expect(resolveCognitoIdpEndpoint(undefined, undefined)).toBeNull()
  })
})

describe("classifyInitiateAuthError", () => {
  it.each([
    "NotAuthorizedException",
    "UserNotFoundException",
    "UserNotConfirmedException",
    "PasswordResetRequiredException",
    "ResourceNotFoundException",
    "InvalidParameterException",
  ])("treats %s as permanent", (type) => {
    expect(classifyInitiateAuthError(400, { __type: type }).reason).toBe("permanent")
  })

  it("strips the AWS namespace prefix from __type", () => {
    const result = classifyInitiateAuthError(400, {
      __type: "com.amazonaws.cognito.identity.provider#NotAuthorizedException",
    })
    expect(result).toEqual({ reason: "permanent", errorType: "NotAuthorizedException" })
  })

  it("treats throttling and 5xx as transient", () => {
    expect(classifyInitiateAuthError(400, { __type: "TooManyRequestsException" }).reason).toBe(
      "transient",
    )
    expect(classifyInitiateAuthError(503, null).reason).toBe("transient")
  })

  it("treats an unrecognised 4xx as permanent", () => {
    expect(classifyInitiateAuthError(403, null)).toEqual({
      reason: "permanent",
      errorType: "http_403",
    })
  })
})

describe("refreshCognitoTokens", () => {
  const OLD_ENV = { ...process.env }
  let fetchMock: FetchMock

  beforeEach(() => {
    __resetRefreshStateForTests()
    jest.spyOn(console, "warn").mockImplementation(() => {})
    jest.spyOn(console, "error").mockImplementation(() => {})
    process.env.AUTH_COGNITO_CLIENT_ID = "test-client-id"
    process.env.AUTH_COGNITO_ISSUER = ISSUER
    delete process.env.COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS
    fetchMock = jest.fn() as unknown as FetchMock
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.env = { ...OLD_ENV }
  })

  it("posts an unsigned InitiateAuth REFRESH_TOKEN_AUTH call and returns fresh tokens", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        AuthenticationResult: {
          AccessToken: "new-access",
          IdToken: "new-id",
          ExpiresIn: 3600,
        },
      }),
    )

    const before = Date.now()
    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.tokens.accessToken).toBe("new-access")
    expect(result.tokens.idToken).toBe("new-id")
    // REFRESH_TOKEN_AUTH does not rotate the refresh token — keep the old one so
    // the session stays refreshable.
    expect(result.tokens.refreshToken).toBe(VALID_REFRESH_TOKEN)
    expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://cognito-idp.us-east-1.amazonaws.com/")
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/x-amz-json-1.1")
    expect(headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth")
    // Unsigned: a public app client needs no SigV4 and no SECRET_HASH.
    expect(Object.keys(headers).some((k) => k.toLowerCase() === "authorization")).toBe(false)
    expect(JSON.parse(init.body as string)).toEqual({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: "test-client-id",
      AuthParameters: { REFRESH_TOKEN: VALID_REFRESH_TOKEN },
    })
  })

  it("keeps a rotated refresh token when Cognito returns one", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        AuthenticationResult: {
          AccessToken: "a",
          IdToken: "b",
          RefreshToken: "rotated",
          ExpiresIn: 60,
        },
      }),
    )

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result.ok && result.tokens.refreshToken).toBe("rotated")
  })

  it("falls back to the configured lifetime when ExpiresIn is absent", async () => {
    process.env.COGNITO_ACCESS_TOKEN_LIFETIME_SECONDS = "7200"
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }),
    )

    const before = Date.now()
    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000)
  })

  it("fails closed on a revoked/expired refresh token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        __type: "NotAuthorizedException",
        message: "Refresh Token has expired",
      }),
    )

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "permanent" })
  })

  it("fails closed (transient) when the request throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "transient" })
  })

  it("fails closed when a non-JSON body comes back with a 2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>gateway</html>",
    } as unknown as Response)

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "transient" })
  })

  it("fails closed when the result is missing an ID token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "only-access" } }),
    )

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "transient" })
  })

  it("rejects malformed input without calling Cognito", async () => {
    await expect(
      refreshCognitoTokens({ refreshToken: "short", tokenSub: "user-1" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_input" })
    await expect(
      refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "" }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_input" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed when the client id is missing", async () => {
    delete process.env.AUTH_COGNITO_CLIENT_ID

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "configuration" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed when no endpoint can be resolved", async () => {
    delete process.env.AUTH_COGNITO_ISSUER
    delete process.env.AWS_REGION
    delete process.env.AWS_DEFAULT_REGION

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "configuration" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses to send an unsigned refresh when a client secret is configured", async () => {
    // A confidential app client needs a SECRET_HASH this path cannot compute.
    // Cognito would answer NotAuthorizedException, which classifies as
    // "permanent" and reads in logs like mass token revocation. Name the real
    // cause instead of silently signing out every user.
    process.env.AUTH_COGNITO_CLIENT_SECRET = "some-secret"

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result).toMatchObject({ ok: false, reason: "configuration" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("never follows a redirect — the refresh token is in the request body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }),
    )

    await refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.redirect).toBe("error")
  })

  it("clamps an absurd ExpiresIn instead of throwing on an out-of-range date", async () => {
    // Date#toISOString throws RangeError beyond ~8.64e15 ms, which would break
    // the module's never-throws contract.
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        AuthenticationResult: { AccessToken: "a", IdToken: "b", ExpiresIn: 1e15 },
      }),
    )

    const result = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "user-1",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(() => new Date(result.tokens.expiresAt).toISOString()).not.toThrow()
  })

  it("does not let one session join another session's refresh", async () => {
    // Same user, two devices, two different refresh tokens. Keying dedup on the
    // sub alone let a revoked session ride along on a valid sibling's refresh.
    const otherToken = "b".repeat(64)
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }),
    )

    await Promise.all([
      refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" }),
      refreshCognitoTokens({ refreshToken: otherToken, tokenSub: "user-1" }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("deduplicates concurrent refreshes for the same user", async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve
      }),
    )

    const a = refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" })
    const b = refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" })

    release(jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }))

    const [ra, rb] = await Promise.all([a, b])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ra).toEqual(rb)
  })

  it("releases the dedup slot so a later refresh still runs", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }),
    )

    await refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" })
    await refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("rate limits a user after the per-window budget is spent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }),
    )

    for (let i = 0; i < 8; i++) {
      const r = await refreshCognitoTokens({
        refreshToken: VALID_REFRESH_TOKEN,
        tokenSub: "burst-user",
      })
      expect(r.ok).toBe(true)
    }

    const blocked = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "burst-user",
    })
    expect(blocked).toMatchObject({ ok: false, reason: "rate_limited" })
    expect(fetchMock).toHaveBeenCalledTimes(8)

    // A different user is unaffected.
    const other = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "other-user",
    })
    expect(other.ok).toBe(true)
  })

  it("grants polling contexts a larger budget", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { AuthenticationResult: { AccessToken: "a", IdToken: "b" } }),
    )

    for (let i = 0; i < 12; i++) {
      const r = await refreshCognitoTokens({
        refreshToken: VALID_REFRESH_TOKEN,
        tokenSub: "poller",
        isPollingContext: true,
      })
      expect(r.ok).toBe(true)
    }

    const blocked = await refreshCognitoTokens({
      refreshToken: VALID_REFRESH_TOKEN,
      tokenSub: "poller",
      isPollingContext: true,
    })
    expect(blocked).toMatchObject({ ok: false, reason: "rate_limited" })
  })

  it("never emits the refresh token to logs", async () => {
    const warnSpy = jest.spyOn(console, "warn")
    const errorSpy = jest.spyOn(console, "error")
    fetchMock.mockRejectedValue(new Error(`upstream rejected ${VALID_REFRESH_TOKEN}`))

    await refreshCognitoTokens({ refreshToken: VALID_REFRESH_TOKEN, tokenSub: "user-1" })

    const emitted = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n")
    expect(emitted).not.toContain(VALID_REFRESH_TOKEN)
    expect(emitted).toContain("[REDACTED_TOKEN]")
  })
})
