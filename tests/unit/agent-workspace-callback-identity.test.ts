/**
 * Consent-callback identity verification (#1234).
 *
 * Two layers:
 *   1. verifyGrantedIdentity() unit tests — the id_token check in isolation.
 *   2. handleOAuthCallback() integration — proves that a wrong / unverifiable
 *      account stores NOTHING and leaves the nonce unconsumed (so the same link
 *      can be retried), while the correct account stores + consumes as before.
 */

// --- Shared mocks -----------------------------------------------------------

// google-auth-library: OAuth2Client.verifyIdToken is driven by mockVerifyImpl.
let mockVerifyImpl: () => Promise<{ getPayload: () => Record<string, unknown> | undefined }> =
  async () => ({ getPayload: () => ({ email: "hagelk@psd401.net", email_verified: true }) })
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(() => ({
    verifyIdToken: () => mockVerifyImpl(),
  })),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sanitizeForLogging: (x: unknown) => x,
  generateRequestId: () => "rid-test",
  startTimer: () => () => {},
}))

import type { createLogger } from "@/lib/logger"
import { verifyGrantedIdentity } from "@/lib/agent-workspace/identity-verification"

const fakeLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as ReturnType<typeof createLogger>
const CLIENT_ID = "test-client-id.apps.googleusercontent.com"

describe("verifyGrantedIdentity (#1234)", () => {
  beforeEach(() => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email: "hagelk@psd401.net", email_verified: true }) })
  })

  it("accepts a verified id_token whose email matches (case-insensitive)", async () => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email: "Hagelk@PSD401.net", email_verified: true }) })
    const r = await verifyGrantedIdentity("tok", CLIENT_ID, "hagelk@psd401.net", fakeLog)
    expect(r.ok).toBe(true)
    expect(r.email).toBe("hagelk@psd401.net")
  })

  it("rejects when the id_token is missing", async () => {
    const r = await verifyGrantedIdentity(undefined, CLIENT_ID, "hagelk@psd401.net", fakeLog)
    expect(r).toEqual({ ok: false, reason: "missing" })
  })

  it("rejects when verification throws (bad signature/audience/issuer)", async () => {
    mockVerifyImpl = async () => { throw new Error("Wrong recipient") }
    const r = await verifyGrantedIdentity("tok", CLIENT_ID, "hagelk@psd401.net", fakeLog)
    expect(r).toEqual({ ok: false, reason: "invalid" })
  })

  it("rejects when the email claim is unverified", async () => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email: "hagelk@psd401.net", email_verified: false }) })
    const r = await verifyGrantedIdentity("tok", CLIENT_ID, "hagelk@psd401.net", fakeLog)
    expect(r).toEqual({ ok: false, reason: "unverified" })
  })

  it("rejects when a different (wrong) account authorized — reason mismatch, granted email surfaced", async () => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email: "someoneelse@psd401.net", email_verified: true }) })
    const r = await verifyGrantedIdentity("tok", CLIENT_ID, "agnt_hagelk@psd401.net", fakeLog)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("mismatch")
    expect(r.email).toBe("someoneelse@psd401.net")
  })

  it("treats a payload with no email claim as invalid", async () => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email_verified: true }) })
    const r = await verifyGrantedIdentity("tok", CLIENT_ID, "hagelk@psd401.net", fakeLog)
    expect(r).toEqual({ ok: false, reason: "invalid" })
  })
})

// --- Integration: handleOAuthCallback --------------------------------------

// Label-dispatched executeQuery mock records which queries ran.
let executedLabels: string[] = []
let userRows: Array<{ id: number }> = [{ id: 1 }]
const nonceRow = { ownerEmail: "hagelk@psd401.net", agentEmail: "agnt_hagelk@psd401.net", tokenKind: "user_account" as const }
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_cb: unknown, label: string) => {
    executedLabels.push(label)
    if (label === "lookupConsentNonce") return [nonceRow]
    if (label === "findUserByEmail") return userRows
    return []
  }),
  executeTransaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}))

const storeRefreshTokenMock = jest.fn(async (..._a: unknown[]) => "arn:aws:secretsmanager:us-east-1:1:secret:x-abc123")
jest.mock("@/lib/agent-workspace/secrets-manager", () => ({
  storeRefreshToken: (...a: unknown[]) => storeRefreshTokenMock(...a),
  getSecretJson: jest.fn(async () => null),
}))
jest.mock("@/lib/oauth/issuer-config", () => ({ getIssuerUrl: () => "https://issuer.example" }))
jest.mock("@/lib/db/drizzle/user-roles", () => ({ addUserRole: jest.fn(async () => {}) }))
// Schema tables + drizzle operators are only used to build query builders that the
// mocked executeQuery never executes — stub them so the import resolves.
jest.mock("@/lib/db/schema/tables/agent-workspace-consent-nonces", () => ({ psdAgentWorkspaceConsentNonces: {} }))
jest.mock("@/lib/db/schema/tables/agent-workspace-tokens", () => ({ psdAgentWorkspaceTokens: {} }))
jest.mock("@/lib/db/schema/tables/users", () => ({ users: {} }))
jest.mock("@/lib/agent-workspace/consent-token", () => ({ verifyConsentToken: jest.fn() }))

import { handleOAuthCallback } from "@/actions/agent-workspace.actions"

const HEX_NONCE = "a".repeat(64)

// Google token-exchange response shape returned by the mocked fetch.
let tokenBody: Record<string, unknown> = {}
beforeEach(() => {
  process.env.GOOGLE_WORKSPACE_CLIENT_ID = CLIENT_ID
  process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = "test-secret"
  executedLabels = []
  userRows = [{ id: 1 }]
  storeRefreshTokenMock.mockClear()
  mockVerifyImpl = async () => ({ getPayload: () => ({ email: "hagelk@psd401.net", email_verified: true }) })
  tokenBody = {
    access_token: "at",
    refresh_token: "rt",
    id_token: "idt",
    token_type: "Bearer",
    expires_in: 3600,
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/tasks",
    ].join(" "),
  }
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => tokenBody,
    text: async () => JSON.stringify(tokenBody),
  })) as unknown as typeof fetch
})

describe("handleOAuthCallback identity enforcement (#1234)", () => {
  it("stores + consumes the nonce when the correct account authorized", async () => {
    const res = await handleOAuthCallback("code", HEX_NONCE)
    expect(res.isSuccess).toBe(true)
    expect(res.data!.success).toBe(true)
    expect(storeRefreshTokenMock).toHaveBeenCalledTimes(1)
    expect(executedLabels).toContain("consumeConsentNonce")
  })

  it("stores NOTHING and leaves the nonce unconsumed on a wrong-account grant", async () => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email: "someoneelse@psd401.net", email_verified: true }) })
    const res = await handleOAuthCallback("code", HEX_NONCE)
    expect(res.data!.success).toBe(false)
    expect(res.data!.error).toContain("hagelk@psd401.net") // names the required account
    expect(storeRefreshTokenMock).not.toHaveBeenCalled()
    expect(executedLabels).not.toContain("consumeConsentNonce") // retryable with the same link
  })

  it("rejects a missing id_token without storing or consuming", async () => {
    delete tokenBody.id_token
    const res = await handleOAuthCallback("code", HEX_NONCE)
    expect(res.data!.success).toBe(false)
    expect(storeRefreshTokenMock).not.toHaveBeenCalled()
    expect(executedLabels).not.toContain("consumeConsentNonce")
  })

  it("rejects an invalid id_token (verify throws) without storing", async () => {
    mockVerifyImpl = async () => { throw new Error("Invalid token signature") }
    const res = await handleOAuthCallback("code", HEX_NONCE)
    expect(res.data!.success).toBe(false)
    expect(storeRefreshTokenMock).not.toHaveBeenCalled()
    expect(executedLabels).not.toContain("consumeConsentNonce")
  })

  it("rejects an unverified email without storing", async () => {
    mockVerifyImpl = async () => ({ getPayload: () => ({ email: "hagelk@psd401.net", email_verified: false }) })
    const res = await handleOAuthCallback("code", HEX_NONCE)
    expect(res.data!.success).toBe(false)
    expect(storeRefreshTokenMock).not.toHaveBeenCalled()
    expect(executedLabels).not.toContain("consumeConsentNonce")
  })
})
