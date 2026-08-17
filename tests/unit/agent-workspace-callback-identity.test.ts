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
// ownerEmail is mutable: one test drives it with directory-supplied casing.
const nonceRow = { ownerEmail: "hagelk@psd401.net", agentEmail: "agnt_hagelk@psd401.net", tokenKind: "user_account" as const }
// The user lookup's predicate is load-bearing (#1682): migration 112 makes
// users.email unique on lower(email), so a case-sensitive compare misses a
// differently-cased row that the index will still reject. Run that one
// builder against a recorder so a test can assert the emitted predicate
// instead of only its label — no other query's shape is exercised here.
let capturedUserWhere: unknown = null
const recordingDb = () => ({
  select: () => ({
    from: () => ({
      where: (predicate: unknown) => {
        capturedUserWhere = predicate
        return { limit: () => userRows }
      },
    }),
  }),
})
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (cb: unknown, label: string) => {
    executedLabels.push(label)
    if (label === "lookupConsentNonce") return [nonceRow]
    if (label === "findUserByEmail") {
      ;(cb as (db: unknown) => unknown)(recordingDb())
      return userRows
    }
    return []
  }),
  executeTransaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(recordingTx())
  ),
}))

// provisionAgentUser's transaction re-checks then INSERTs. Record the inserted
// values so a test can assert the stored casing — migration 112 makes
// users.email unique on lower(email), so a mixed-case row is invisible to any
// case-sensitive reader. `userRows` drives the re-check: non-empty means the
// user already exists and no INSERT happens.
let insertedUserValues: { email?: string } | null = null
const recordingTx = () => ({
  select: () => ({
    from: () => ({ where: () => ({ limit: () => userRows }) }),
  }),
  insert: () => ({
    values: (values: { email?: string }) => {
      insertedUserValues = values
      return { returning: () => [{ id: 99 }] }
    },
  }),
})

/** Literal SQL text of a drizzle fragment, dropping bound params. */
function sqlText(fragment: unknown): string {
  const chunks = (fragment as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? []
  return chunks.map((c) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("")
}

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
  nonceRow.ownerEmail = "hagelk@psd401.net"
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

  // #1682. users.email is unique on lower(email) (migration 112), and the
  // Cognito upsert stores whatever casing the IdP sends — one prod owner's row
  // is GEORGEK@psd401.net. A case-sensitive lookup misses her, routes an
  // existing user into auto-provisioning, and that INSERT then dies on
  // uq_users_email_lower, so the callback throws and every retry fails
  // identically. The predicate must lower BOTH sides to match the index.
  it("looks the owner up case-insensitively so a differently-cased row is found", async () => {
    capturedUserWhere = null
    await handleOAuthCallback("code", HEX_NONCE)

    expect(executedLabels).toContain("findUserByEmail")
    const predicate = sqlText(capturedUserWhere)
    expect(predicate).toContain("lower(")
    // Both sides — lowering only the column still misses a mixed-case input.
    expect(predicate.match(/lower\(/g) ?? []).toHaveLength(2)
    expect(predicate).not.toMatch(/^\s*=/)
  })

  // The nonce's ownerEmail carries whatever casing the directory supplied, so
  // auto-provisioning must not plant a fresh mixed-case row behind the
  // lower(email) unique index it will later be read through.
  it("auto-provisions a new owner with a normalized email", async () => {
    userRows = [] // no existing row -> falls through to provisionAgentUser
    insertedUserValues = null
    // Directory-supplied casing, exactly what put GEORGEK@psd401.net in prod.
    nonceRow.ownerEmail = "HAGELK@PSD401.NET"
    mockVerifyImpl = async () => ({
      getPayload: () => ({ email: "HAGELK@PSD401.NET", email_verified: true }),
    })

    await handleOAuthCallback("code", HEX_NONCE)

    expect(insertedUserValues).not.toBeNull()
    expect(insertedUserValues!.email).toBe("hagelk@psd401.net")
  })
})
