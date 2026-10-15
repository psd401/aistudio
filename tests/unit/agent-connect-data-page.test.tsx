/** @jest-environment node */

/**
 * #1902 — `/agent-connect-data` is the ONLY caller allowed to create the
 * per-user cognito-refresh secret. Sign-in is update-only, so if this page
 * stopped passing `{ createIfMissing: true }`, a user who has never connected
 * the agent could never get a secret.
 */

const syncCognitoRefreshMock = jest.fn()
const authMock = jest.fn()
const verifyConsentTokenMock = jest.fn()
const executeQueryMock = jest.fn()

jest.mock("@/auth", () => ({
  createAuth: () => ({ auth: authMock }),
}))
jest.mock("@/lib/agent-workspace/consent-token", () => ({
  verifyConsentToken: (...args: unknown[]) => verifyConsentTokenMock(...args),
}))
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}))
jest.mock("@/lib/auth/agent-token-sync", () => ({
  syncCognitoRefreshForAgent: (...args: unknown[]) =>
    syncCognitoRefreshMock(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  sanitizeForLogging: (value: unknown) => value,
}))

import AgentConnectDataPage from "@/app/agent-connect-data/page"

const OWNER_EMAIL = "consent-user@example.com"

describe("/agent-connect-data consent page", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    verifyConsentTokenMock.mockResolvedValue({
      kind: "cognito_data",
      nonce: "nonce-1",
      sub: OWNER_EMAIL,
    })
    authMock.mockResolvedValue({
      user: { email: OWNER_EMAIL },
      refreshToken: "refresh-consent",
    })
    syncCognitoRefreshMock.mockResolvedValue("arn:secret")
    executeQueryMock.mockResolvedValue([{ nonce: "nonce-1" }])
  })

  it("writes the session refresh token with createIfMissing: true", async () => {
    await AgentConnectDataPage({
      searchParams: Promise.resolve({ token: "signed-token" }),
    })

    expect(syncCognitoRefreshMock).toHaveBeenCalledTimes(1)
    expect(syncCognitoRefreshMock).toHaveBeenCalledWith(
      OWNER_EMAIL,
      "refresh-consent",
      { createIfMissing: true },
    )
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
  })

  it("leaves the nonce unburned when the write fails", async () => {
    syncCognitoRefreshMock.mockResolvedValue(null)

    await AgentConnectDataPage({
      searchParams: Promise.resolve({ token: "signed-token" }),
    })

    expect(executeQueryMock).not.toHaveBeenCalled()
  })
})
