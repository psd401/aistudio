/** @jest-environment node */

import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals"

type CognitoResult = {
  AuthenticationResult: {
    AccessToken: string
    IdToken: string
    ExpiresIn: number
  }
}

const sendMock = jest.fn<(command: unknown) => Promise<CognitoResult>>()

jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: sendMock })),
  InitiateAuthCommand: jest.fn((input: unknown) => ({ input })),
  AuthFlowType: { REFRESH_TOKEN_AUTH: "REFRESH_TOKEN_AUTH" },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "request-id",
  startTimer: () => jest.fn(),
}))

jest.mock("@/lib/error-utils", () => ({
  createSuccess: (data: unknown, message: string) => ({ success: true, data, message }),
  handleError: (error: unknown) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }),
  ErrorFactories: {
    validationFailed: (details: unknown) => new Error(`validation: ${JSON.stringify(details)}`),
    externalApiRateLimit: () => new Error("rate limited"),
    sysConfigurationError: (message: string) => new Error(message),
    authInvalidToken: (_kind: string, detail?: { message?: string }) =>
      new Error(detail?.message ?? "invalid token"),
  },
}))

function idToken(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")
  return `${header}.${payload}.signature`
}

function response(subject: string, suffix: string): CognitoResult {
  return {
    AuthenticationResult: {
      AccessToken: `access-${suffix}`,
      IdToken: idToken(subject),
      ExpiresIn: 3600,
    },
  }
}

describe("refresh token authority and deduplication", () => {
  let refreshCognitoToken:
    typeof import("@/actions/auth/refresh-token-action").refreshCognitoToken

  beforeAll(async () => {
    ({ refreshCognitoToken } = await import("@/actions/auth/refresh-token-action"))
  })

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.AUTH_COGNITO_CLIENT_ID = "client-id"
    process.env.AWS_REGION = "us-east-1"
  })

  it("deduplicates only callers possessing the exact same refresh token", async () => {
    let resolveRequest: ((value: CognitoResult) => void) | undefined
    sendMock.mockImplementationOnce(
      () =>
        new Promise<CognitoResult>((resolve) => {
          resolveRequest = resolve
        }),
    )

    const first = refreshCognitoToken({
      refreshToken: "refresh-token-one",
      tokenSub: "subject-one",
    })
    const second = refreshCognitoToken({
      refreshToken: "refresh-token-one",
      tokenSub: "subject-one",
    })

    await Promise.resolve()
    expect(sendMock).toHaveBeenCalledTimes(1)
    resolveRequest?.(response("subject-one", "one"))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
  })

  it("does not share a token-bearing promise by caller-supplied subject", async () => {
    sendMock
      .mockResolvedValueOnce(response("shared-subject", "one"))
      .mockResolvedValueOnce(response("shared-subject", "two"))

    const [first, second] = await Promise.all([
      refreshCognitoToken({
        refreshToken: "refresh-token-one",
        tokenSub: "shared-subject",
      }),
      refreshCognitoToken({
        refreshToken: "refresh-token-two",
        tokenSub: "shared-subject",
      }),
    ])

    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(first).not.toEqual(second)
  })

  it("rejects Cognito output whose subject does not match the requested session", async () => {
    sendMock.mockResolvedValueOnce(response("victim-subject", "victim"))

    const result = await refreshCognitoToken({
      refreshToken: "victim-refresh-token",
      tokenSub: "attacker-subject",
    })

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/subject mismatch/i),
      }),
    )
  })
})
