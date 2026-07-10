/**
 * Unit tests for lib/oauth/drizzle-adapter.ts.
 *
 * Covers:
 * - REV-DB-164: consume('RefreshToken') stamps rotated_at; findRefreshToken maps it to `consumed`.
 * - REV-DB-166: the DB upserts are true upserts (onConflictDoUpdate), not insert-only.
 * - REV-DB-167: the read paths use explicit column projections (and still map correctly).
 * - REV-DB-170: upsert rejects a missing/non-numeric accountId before any DB write.
 *
 * `executeQuery` is mocked with a recording query-builder so we can assert the exact Drizzle
 * chain each adapter method builds without a live database.
 */

import type { AdapterPayload } from "oidc-provider"

// ─── Recording query-builder ─────────────────────────────────────────────────
interface Recorder {
  db: Record<string, (...args: unknown[]) => unknown>
  calls: Record<string, unknown[][]>
}

function makeRecorder(): Recorder {
  const calls: Record<string, unknown[][]> = {}
  const db: Record<string, (...args: unknown[]) => unknown> = {}
  const methods = [
    "insert",
    "values",
    "onConflictDoUpdate",
    "onConflictDoNothing",
    "update",
    "set",
    "where",
    "select",
    "from",
    "limit",
    "returning",
    "delete",
  ]
  for (const m of methods) {
    db[m] = (...args: unknown[]) => {
      ;(calls[m] ??= []).push(args)
      return db
    }
  }
  return { db, calls }
}

let recordings: Recorder[] = []
let nextRows: unknown[] = []

function lastCalls(): Record<string, unknown[][]> {
  return recordings[recordings.length - 1].calls
}

// ─── Mocks ───────────────────────────────────────────────────────────────────
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
}))

jest.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => ({ _eq: args }),
  and: (...args: unknown[]) => ({ _and: args }),
  isNull: (...args: unknown[]) => ({ _isNull: args }),
}))

jest.mock("@/lib/db/schema", () => {
  // Each table proxies any column access to the column name string, so assertions can
  // compare e.g. onConflictDoUpdate target === "codeHash".
  const mk = () =>
    new Proxy({}, { get: (_t, prop) => (typeof prop === "string" ? prop : undefined) })
  return {
    oauthClients: mk(),
    oauthAuthorizationCodes: mk(),
    oauthAccessTokens: mk(),
    oauthRefreshTokens: mk(),
  }
})

jest.mock("@/lib/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return { createLogger: () => logger }
})

jest.mock("@/lib/content/helpers", () => ({
  systemUserIdOrNull: jest.fn(() => null),
}))

import { DrizzleOidcAdapter } from "@/lib/oauth/drizzle-adapter"
import { executeQuery } from "@/lib/db/drizzle-client"
import { createLogger } from "@/lib/logger"

const executeQueryMock = executeQuery as jest.Mock
const loggerWarn = (createLogger({}) as unknown as { warn: jest.Mock }).warn

function payload(overrides: Record<string, unknown>): AdapterPayload {
  return overrides as unknown as AdapterPayload
}

beforeEach(() => {
  recordings = []
  nextRows = []
  jest.clearAllMocks()
  executeQueryMock.mockImplementation(async (fn: (db: unknown) => unknown) => {
    const rec = makeRecorder()
    recordings.push(rec)
    fn(rec.db)
    return nextRows
  })
})

// ─── REV-DB-170 ──────────────────────────────────────────────────────────────
describe("upsert accountId validation (REV-DB-170)", () => {
  it("AuthorizationCode upsert throws on a missing accountId (no DB write)", async () => {
    const adapter = DrizzleOidcAdapter("AuthorizationCode")
    await expect(
      adapter.upsert("code1", payload({ clientId: "c" }), 60)
    ).rejects.toThrow(/non-numeric accountId/)
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("RefreshToken upsert throws on a non-numeric accountId (no DB write)", async () => {
    const adapter = DrizzleOidcAdapter("RefreshToken")
    await expect(
      adapter.upsert("rt1", payload({ clientId: "c", accountId: "abc" }), 3600)
    ).rejects.toThrow(/non-numeric accountId/)
    expect(executeQueryMock).not.toHaveBeenCalled()
  })

  it("AuthorizationCode upsert inserts a valid numeric userId", async () => {
    const adapter = DrizzleOidcAdapter("AuthorizationCode")
    await adapter.upsert(
      "code1",
      payload({ clientId: "c", accountId: "42", scope: "openid email" }),
      60
    )
    const values = lastCalls().values[0][0] as { userId: number; codeHash: string }
    expect(values.userId).toBe(42)
    expect(values.codeHash).toEqual(expect.any(String))
  })
})

// ─── REV-DB-166 ──────────────────────────────────────────────────────────────
describe("upserts honour the insert-OR-update contract (REV-DB-166)", () => {
  it("AuthorizationCode upsert uses onConflictDoUpdate on codeHash", async () => {
    const adapter = DrizzleOidcAdapter("AuthorizationCode")
    await adapter.upsert(
      "code1",
      payload({ clientId: "c", accountId: "1", scope: "openid" }),
      60
    )
    const conflict = lastCalls().onConflictDoUpdate[0][0] as {
      target: unknown
      set: Record<string, unknown>
    }
    expect(conflict.target).toBe("codeHash")
    expect(conflict.set).toMatchObject({ clientId: "c", userId: 1 })
    // The unique key is never in the update set.
    expect(conflict.set).not.toHaveProperty("codeHash")
  })

  it("AccessToken upsert uses onConflictDoUpdate on jti", async () => {
    const adapter = DrizzleOidcAdapter("AccessToken")
    await adapter.upsert(
      "jti1",
      payload({ clientId: "c", accountId: "1", scope: "openid" }),
      900
    )
    const conflict = lastCalls().onConflictDoUpdate[0][0] as {
      target: unknown
      set: Record<string, unknown>
    }
    expect(conflict.target).toBe("jti")
    expect(conflict.set).not.toHaveProperty("jti")
  })

  it("RefreshToken upsert uses onConflictDoUpdate on tokenHash, excluding lifecycle columns", async () => {
    const adapter = DrizzleOidcAdapter("RefreshToken")
    await adapter.upsert(
      "rt1",
      payload({ clientId: "c", accountId: "1", scope: "openid" }),
      3600
    )
    const conflict = lastCalls().onConflictDoUpdate[0][0] as {
      target: unknown
      set: Record<string, unknown>
    }
    expect(conflict.target).toBe("tokenHash")
    // A re-upsert must not resurrect a rotated/revoked token, nor rewrite the unique key.
    expect(conflict.set).not.toHaveProperty("rotatedAt")
    expect(conflict.set).not.toHaveProperty("revokedAt")
    expect(conflict.set).not.toHaveProperty("tokenHash")
  })
})

// ─── REV-DB-164 ──────────────────────────────────────────────────────────────
describe("consume('RefreshToken') stamps rotated_at (REV-DB-164)", () => {
  it("issues an UPDATE that sets rotatedAt and returns the row id", async () => {
    nextRows = [{ id: 1 }]
    const adapter = DrizzleOidcAdapter("RefreshToken")
    await adapter.consume("rt1")

    const calls = lastCalls()
    expect(calls.update).toHaveLength(1)
    const setArg = calls.set[0][0] as Record<string, unknown>
    expect(setArg).toHaveProperty("rotatedAt")
    expect(setArg.rotatedAt).toBeInstanceOf(Date)
    // returning({ id }) is used to detect the "already consumed / not found" case.
    expect(calls.returning).toHaveLength(1)
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it("warns when no row matched (already consumed or not found)", async () => {
    nextRows = []
    const adapter = DrizzleOidcAdapter("RefreshToken")
    await adapter.consume("rt-missing")

    expect(loggerWarn).toHaveBeenCalledWith(
      "Refresh token already consumed or not found",
      expect.objectContaining({ tokenHash: expect.any(String) })
    )
  })

  it("leaves the AuthorizationCode consume path unchanged (sets consumedAt)", async () => {
    nextRows = [{ id: 5 }]
    const adapter = DrizzleOidcAdapter("AuthorizationCode")
    await adapter.consume("code1")

    const setArg = lastCalls().set[0][0] as Record<string, unknown>
    expect(setArg).toHaveProperty("consumedAt")
    expect(setArg).not.toHaveProperty("rotatedAt")
  })
})

// ─── REV-DB-167 ──────────────────────────────────────────────────────────────
describe("read paths use explicit projections and map unchanged (REV-DB-167)", () => {
  it("findClient projects only consumed columns and maps them", async () => {
    nextRows = [
      {
        clientId: "c1",
        clientName: "App",
        clientSecretHash: null,
        redirectUris: ["https://x/cb"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        allowedScopes: ["openid"],
        tokenEndpointAuthMethod: "none",
      },
    ]
    const result = await DrizzleOidcAdapter("Client").find("c1")

    const projection = lastCalls().select[0][0] as Record<string, unknown>
    expect(Object.keys(projection).sort()).toEqual([
      "allowedScopes",
      "clientId",
      "clientName",
      "clientSecretHash",
      "grantTypes",
      "redirectUris",
      "responseTypes",
      "tokenEndpointAuthMethod",
    ])
    expect(result).toMatchObject({
      client_id: "c1",
      client_name: "App",
      redirect_uris: ["https://x/cb"],
      scope: "openid",
      token_endpoint_auth_method: "none",
    })
  })

  it("findAccessToken projects only consumed columns and maps them", async () => {
    nextRows = [
      {
        jti: "j1",
        userId: 7,
        clientId: "c1",
        scopes: ["openid", "email"],
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      },
    ]
    const result = await DrizzleOidcAdapter("AccessToken").find("j1")

    const projection = lastCalls().select[0][0] as Record<string, unknown>
    expect(Object.keys(projection).sort()).toEqual([
      "clientId",
      "expiresAt",
      "jti",
      "scopes",
      "userId",
    ])
    expect(result).toMatchObject({
      jti: "j1",
      accountId: "7",
      clientId: "c1",
      scope: "openid email",
    })
  })

  it("findRefreshToken projects columns and maps rotatedAt to a numeric consumed", async () => {
    const rotatedAt = new Date("2030-06-01T00:00:00Z")
    nextRows = [
      {
        userId: 7,
        clientId: "c1",
        scopes: ["openid"],
        expiresAt: new Date("2030-07-01T00:00:00Z"),
        rotatedAt,
      },
    ]
    const result = (await DrizzleOidcAdapter("RefreshToken").find(
      "rt1"
    )) as AdapterPayload

    const projection = lastCalls().select[0][0] as Record<string, unknown>
    expect(Object.keys(projection).sort()).toEqual([
      "clientId",
      "expiresAt",
      "rotatedAt",
      "scopes",
      "userId",
    ])
    expect(result.consumed).toBe(Math.floor(rotatedAt.getTime() / 1000))
  })

  it("findAuthCode uses an explicit projection and maps it", async () => {
    nextRows = [
      {
        userId: 7,
        clientId: "c1",
        redirectUri: "https://x/cb",
        scopes: ["openid"],
        codeChallenge: null,
        codeChallengeMethod: "S256",
        nonce: null,
        consumedAt: null,
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      },
    ]
    const result = (await DrizzleOidcAdapter("AuthorizationCode").find(
      "code1"
    )) as AdapterPayload

    const projection = lastCalls().select[0][0] as Record<string, unknown>
    expect(projection).toHaveProperty("redirectUri")
    expect(projection).not.toHaveProperty("createdAt")
    expect(result).toMatchObject({
      accountId: "7",
      clientId: "c1",
      redirectUri: "https://x/cb",
      scope: "openid",
    })
  })
})
