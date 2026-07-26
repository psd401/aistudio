let sessionEmail: string | null = "owner@psd401.net"
let consentPayload:
  | {
      sub: string
      nonce: string
      kind: "canva" | "plaud"
    }
  | null = null
let queryRows: unknown[] = []

const getServerSessionMock = jest.fn(async () =>
  sessionEmail ? { sub: "session-user", email: sessionEmail } : null
)
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: () => getServerSessionMock(),
}))

const verifyConsentTokenMock = jest.fn(async () => consentPayload)
jest.mock("@/lib/agent-workspace/consent-token", () => ({
  verifyConsentToken: () => verifyConsentTokenMock(),
}))

const executeQueryMock = jest.fn(
  async (_query: unknown, _operation: string) => queryRows
)
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (query: unknown, operation: string) =>
    executeQueryMock(query, operation),
}))

const getSecretJsonMock = jest.fn()
const storeCanvaRefreshTokenMock = jest.fn()
const storePlaudRefreshTokenMock = jest.fn()
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  getSecretJson: (...args: unknown[]) => getSecretJsonMock(...args),
  putSecretString: jest.fn(),
  storeCanvaRefreshToken: (...args: unknown[]) =>
    storeCanvaRefreshTokenMock(...args),
  storePlaudRefreshToken: (...args: unknown[]) =>
    storePlaudRefreshTokenMock(...args),
}))

jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: () => "https://app.test",
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
  generateRequestId: () => "rid-test",
  startTimer: () => jest.fn(),
  getLogContext: () => ({}),
}))

import {
  handleCanvaCallback,
  verifyCanvaConsentAndGetOAuthUrl,
} from "@/actions/agent-canva.actions"
import {
  handlePlaudCallback,
  verifyPlaudConsentAndGetOAuthUrl,
} from "@/actions/agent-plaud.actions"

const NONCE = "a".repeat(64)

beforeEach(() => {
  sessionEmail = "owner@psd401.net"
  consentPayload = null
  queryRows = []
  getServerSessionMock.mockClear()
  verifyConsentTokenMock.mockClear()
  executeQueryMock.mockClear()
  getSecretJsonMock.mockReset()
  storeCanvaRefreshTokenMock.mockReset()
  storePlaudRefreshTokenMock.mockReset()
  global.fetch = jest.fn()
})

describe.each([
  {
    provider: "Canva",
    kind: "canva" as const,
    verify: verifyCanvaConsentAndGetOAuthUrl,
    callback: handleCanvaCallback,
    storeMock: storeCanvaRefreshTokenMock,
  },
  {
    provider: "Plaud",
    kind: "plaud" as const,
    verify: verifyPlaudConsentAndGetOAuthUrl,
    callback: handlePlaudCallback,
    storeMock: storePlaudRefreshTokenMock,
  },
])("$provider consent owner binding", ({ kind, verify, callback, storeMock }) => {
  it("does not start OAuth for a different or sessionless AI Studio user", async () => {
    consentPayload = {
      sub: "owner@psd401.net",
      nonce: NONCE,
      kind,
    }
    sessionEmail = "victim@psd401.net"

    const mismatch = await verify("signed-token")
    expect(mismatch.isSuccess).toBe(true)
    if (mismatch.isSuccess) {
      expect(mismatch.data.valid).toBe(false)
    }
    expect(executeQueryMock).not.toHaveBeenCalled()
    expect(getSecretJsonMock).not.toHaveBeenCalled()

    sessionEmail = null
    const sessionless = await verify("signed-token")
    expect(sessionless.isSuccess).toBe(true)
    if (sessionless.isSuccess) {
      expect(sessionless.data.valid).toBe(false)
    }
  })

  it("does not exchange or store a token when callback owner differs", async () => {
    sessionEmail = "victim@psd401.net"
    queryRows = [
      {
        ownerEmail: "owner@psd401.net",
        tokenKind: kind,
        codeVerifier: "v".repeat(43),
      },
    ]

    const result = await callback("provider-code", NONCE)
    expect(result.isSuccess).toBe(true)
    if (result.isSuccess) {
      expect(result.data.success).toBe(false)
    }
    expect(global.fetch).not.toHaveBeenCalled()
    expect(storeMock).not.toHaveBeenCalled()
  })

  it("preserves start and callback behavior for the matching owner", async () => {
    consentPayload = {
      sub: "owner@psd401.net",
      nonce: NONCE,
      kind,
    }
    queryRows = [
      {
        ownerEmail: "owner@psd401.net",
        tokenKind: kind,
        codeVerifier: "v".repeat(43),
      },
    ]
    getSecretJsonMock.mockResolvedValue({
      client_id: "client-id",
      client_secret: "client-secret",
    })

    const start = await verify("signed-token")
    expect(start.isSuccess).toBe(true)
    if (start.isSuccess) {
      expect(start.data.valid).toBe(true)
      const oauthUrl =
        "canvaOAuthUrl" in start.data
          ? start.data.canvaOAuthUrl
          : "plaudOAuthUrl" in start.data
            ? start.data.plaudOAuthUrl
            : undefined
      expect(oauthUrl).toContain("client_id=client-id")
    }

    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
          refresh_token: "provider-refresh-token",
          scope: "read write",
          }),
        }) as Response
    )
    const completed = await callback("provider-code", NONCE)
    if (!completed.isSuccess) {
      throw completed.error instanceof Error
        ? completed.error
        : new Error(completed.message)
    }
    expect(completed.isSuccess).toBe(true)
    if (completed.isSuccess) {
      expect(completed.data).toMatchObject({
        success: true,
        ownerEmail: "owner@psd401.net",
      })
    }
    expect(storeMock).toHaveBeenCalledWith(
      "owner@psd401.net",
      expect.objectContaining({
        refresh_token: "provider-refresh-token",
      })
    )
  })
})
