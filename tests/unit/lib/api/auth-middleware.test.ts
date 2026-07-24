/**
 * Unit tests for API Authentication Middleware
 * Tests dual-mode auth (Bearer token + session fallback), scope enforcement,
 * and error response formatting.
 *
 * @see lib/api/auth-middleware.ts
 * Issue #677 - API authentication middleware
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, jest } from "@jest/globals"
import { NextResponse } from "next/server"

// ============================================
// Mocks — must be before imports
// ============================================

jest.mock("@/lib/logger", () => ({
  __esModule: true,
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  generateRequestId: jest.fn(() => "test-request-id"),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((data: unknown) => data),
}))

const mockValidateApiKey = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockHasScope = jest.fn<(...args: unknown[]) => unknown>()
const mockUpdateKeyLastUsed = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock("@/lib/api-keys/key-service", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
  hasScope: (...args: unknown[]) => mockHasScope(...args),
  updateKeyLastUsed: (...args: unknown[]) => mockUpdateKeyLastUsed(...args),
}))

const mockGetServerSession = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

const mockGetUserIdByCognitoSubAsNumber = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.mock("@/lib/db/drizzle/utils", () => ({
  getUserIdByCognitoSubAsNumber: (...args: unknown[]) =>
    mockGetUserIdByCognitoSubAsNumber(...args),
}))

const mockGetUserRolesByCognitoSub = jest.fn<(...args: unknown[]) => Promise<string[]>>()
jest.mock("@/lib/db/drizzle/users", () => ({
  getUserRolesByCognitoSub: (...args: unknown[]) => mockGetUserRolesByCognitoSub(...args),
}))

// JWT path (REV-SEC-164): mock the dynamic imports verifyJwtToken pulls in.
const mockJwtVerify = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.mock("jose", () => ({ jwtVerify: (...args: unknown[]) => mockJwtVerify(...args) }))
jest.mock("@/lib/oauth/jwks-cache", () => ({ getJwksKeySet: jest.fn(async () => ({})) }))
jest.mock("@/lib/oauth/issuer-config", () => ({ getIssuerUrl: () => "https://issuer.example" }))

const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
  and: jest.fn(),
  gt: jest.fn(),
  isNull: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  users: { id: "id", cognitoSub: "cognito_sub" },
  oauthAccessTokens: {
    jti: "jti",
    userId: "user_id",
    clientId: "client_id",
    scopes: "scopes",
    revokedAt: "revoked_at",
    expiresAt: "expires_at",
  },
  oauthClients: { clientId: "client_id", isActive: "is_active" },
}))

// Import after mocks — use require() to ensure mocks are registered first
// (next/jest SWC transform may not properly hoist jest.mock before static imports)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticateRequest, requireScope, createErrorResponse, createApiResponse } = require("@/lib/api/auth-middleware")
// Real role→scope mapping (single source of truth) for asserting session scopes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getScopesForRoles } = require("@/lib/api-keys/scopes")

// ============================================
// Fix global Headers mock (tests/setup.ts drops constructor init)
// ============================================

const OriginalHeaders = global.Headers
beforeAll(() => {
  global.Headers = class extends Map<string, string> {
    constructor(init?: Record<string, string> | [string, string][] | undefined) {
      super()
      if (init) {
        const entries = Array.isArray(init) ? init : Object.entries(init)
        for (const [key, value] of entries) {
          this.set(key, value)
        }
      }
    }
  } as unknown as typeof Headers
})
afterAll(() => {
  global.Headers = OriginalHeaders
})

// ============================================
// Helpers
// ============================================

function createMockRequest(
  headers: Record<string, string> = {},
  url: string = "http://localhost:3000/api/v1/test"
): Request {
  return new Request(url, { headers })
}

/** Type guard: auth succeeded (has userId) vs error response (has status) */
function isAuthContext(result: unknown): boolean {
  return result !== null && typeof result === "object" && "userId" in (result as Record<string, unknown>)
}

// ============================================
// Tests
// ============================================

describe("API Auth Middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateKeyLastUsed.mockResolvedValue(undefined)
    mockGetUserRolesByCognitoSub.mockResolvedValue([])
  })

  // ------------------------------------------
  // Bearer Token Authentication
  // ------------------------------------------
  describe("Bearer token authentication", () => {
    it("should authenticate valid API key and return ApiAuthContext", async () => {
      mockValidateApiKey.mockResolvedValue({
        userId: 42,
        scopes: ["chat:read", "chat:write"],
        keyId: 7,
        authType: "api_key",
      })
      // Mock getCognitoSubByUserId (dynamic import inside auth-middleware)
      mockExecuteQuery.mockResolvedValue([{ cognitoSub: "cognito-sub-42" }])

      const request = createMockRequest({
        authorization: "Bearer sk-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      })

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(true)
      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.userId).toBe(42)
      expect(auth.authType).toBe("api_key")
      expect(auth.scopes).toEqual(["chat:read", "chat:write"])
      expect(auth.apiKeyId).toBe(7)
      expect(auth.cognitoSub).toBe("cognito-sub-42")
    })

    it("should return 401 when API key is invalid", async () => {
      mockValidateApiKey.mockResolvedValue(null)

      const request = createMockRequest({
        authorization: "Bearer sk-invalid0000000000000000000000000000000000000000000000000000000000",
      })

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      const response = result as unknown as { status: number; json: () => Promise<{ error: { code: string } }> }
      expect(response.status).toBe(401)
      const body = await response.json()
      expect(body.error.code).toBe("INVALID_TOKEN")
    })

    it("should NOT fall back to session when Bearer token present but invalid", async () => {
      mockValidateApiKey.mockResolvedValue(null)
      mockGetServerSession.mockResolvedValue({
        sub: "test-cognito-sub",
        email: "test@example.com",
      })

      const request = createMockRequest({
        authorization: "Bearer sk-invalid0000000000000000000000000000000000000000000000000000000000",
      })

      const result = await authenticateRequest(request as never)

      // Must be error response, not session auth
      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
      // getServerSession should never be called
      expect(mockGetServerSession).not.toHaveBeenCalled()
    })

    it("should return 401 for empty Bearer token", async () => {
      const request = createMockRequest({
        authorization: "Bearer ",
      })

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
      // validateApiKey should NOT be called with empty string
      expect(mockValidateApiKey).not.toHaveBeenCalled()
    })

    it("should return 401 when user not found for API key", async () => {
      mockValidateApiKey.mockResolvedValue({
        userId: 999,
        scopes: ["chat:read"],
        keyId: 1,
        authType: "api_key",
      })
      // getCognitoSubByUserId returns no user
      mockExecuteQuery.mockResolvedValue([])

      const request = createMockRequest({
        authorization: "Bearer sk-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      })

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
    })

    it("should fire-and-forget updateKeyLastUsed on successful auth", async () => {
      mockValidateApiKey.mockResolvedValue({
        userId: 42,
        scopes: ["chat:read"],
        keyId: 7,
        authType: "api_key",
      })
      mockExecuteQuery.mockResolvedValue([{ cognitoSub: "cognito-sub-42" }])

      const request = createMockRequest({
        authorization: "Bearer sk-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      })

      await authenticateRequest(request as never)

      expect(mockUpdateKeyLastUsed).toHaveBeenCalledWith(7)
    })

    it("should return 500 on unexpected validation error", async () => {
      mockValidateApiKey.mockRejectedValue(new Error("DB connection failed"))

      const request = createMockRequest({
        authorization: "Bearer sk-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      })

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(500)
      const body = await (result as unknown as { json: () => Promise<{ error: { code: string } }> }).json()
      expect(body.error.code).toBe("INTERNAL_ERROR")
    })
  })

  // ------------------------------------------
  // Session Authentication (fallback)
  // ------------------------------------------
  describe("Session authentication fallback", () => {
    it("should authenticate via session with role-derived scopes, not wildcard (REV-SEC-161)", async () => {
      mockGetServerSession.mockResolvedValue({
        sub: "test-cognito-sub",
        email: "test@example.com",
      })
      mockGetUserIdByCognitoSubAsNumber.mockResolvedValue(42)
      mockGetUserRolesByCognitoSub.mockResolvedValue(["administrator"])

      const request = createMockRequest({})

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(true)
      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.userId).toBe(42)
      expect(auth.authType).toBe("session")
      // No longer a blanket "*" — scopes come from the role→scope mapping.
      expect(auth.scopes).not.toEqual(["*"])
      expect(auth.scopes).toEqual(getScopesForRoles(["administrator"]))
      expect(auth.cognitoSub).toBe("test-cognito-sub")
      expect(auth.apiKeyId).toBeUndefined()
    })

    it("a student session gets only student scopes, never graph:write or wildcard (REV-SEC-161)", async () => {
      mockGetServerSession.mockResolvedValue({ sub: "student-sub" })
      mockGetUserIdByCognitoSubAsNumber.mockResolvedValue(7)
      mockGetUserRolesByCognitoSub.mockResolvedValue(["student"])

      const result = await authenticateRequest(createMockRequest({}) as never)

      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.scopes).toEqual(getScopesForRoles(["student"]))
      expect(auth.scopes).not.toContain("*")
      expect(auth.scopes).not.toContain("graph:write")
    })

    it("an administrator session gets graph:write (REV-SEC-161)", async () => {
      mockGetServerSession.mockResolvedValue({ sub: "admin-sub" })
      mockGetUserIdByCognitoSubAsNumber.mockResolvedValue(1)
      mockGetUserRolesByCognitoSub.mockResolvedValue(["administrator"])

      const result = await authenticateRequest(createMockRequest({}) as never)

      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.scopes).toContain("graph:write")
    })

    it("should return 401 when no session exists", async () => {
      mockGetServerSession.mockResolvedValue(null)

      const request = createMockRequest({})

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
      const body = await (result as unknown as { json: () => Promise<{ error: { code: string } }> }).json()
      expect(body.error.code).toBe("UNAUTHORIZED")
    })

    it("should return 401 when session has no sub", async () => {
      mockGetServerSession.mockResolvedValue({
        email: "test@example.com",
      })

      const request = createMockRequest({})

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
    })

    it("should return 401 when user not found in database", async () => {
      mockGetServerSession.mockResolvedValue({
        sub: "orphaned-cognito-sub",
        email: "orphan@example.com",
      })
      mockGetUserIdByCognitoSubAsNumber.mockResolvedValue(null)

      const request = createMockRequest({})

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
    })

    it("should return 500 on session retrieval error", async () => {
      mockGetServerSession.mockRejectedValue(new Error("Auth service down"))

      const request = createMockRequest({})

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(500)
    })

    it("should use session for non-Bearer Authorization headers", async () => {
      mockGetServerSession.mockResolvedValue({
        sub: "test-cognito-sub",
      })
      mockGetUserIdByCognitoSubAsNumber.mockResolvedValue(42)

      // Basic auth, not Bearer — should fall through to session
      const request = createMockRequest({
        authorization: "Basic dXNlcjpwYXNz",
      })

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(true)
      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.authType).toBe("session")
      expect(mockValidateApiKey).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------
  // Scope Enforcement
  // ------------------------------------------
  // ------------------------------------------
  // JWT Bearer Authentication (REV-SEC-164)
  // ------------------------------------------
  describe("JWT bearer authentication", () => {
    it("verifies the token with explicit issuer + audience constraints (REV-SEC-164)", async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: "5",
          jti: "token-1",
          scope: "chat:read chat:write",
          client_id: "agent-1",
        },
      })
      mockExecuteQuery.mockResolvedValue([
        {
          cognitoSub: "cognito-5",
          userId: 5,
          clientId: "agent-1",
          scopes: ["chat:read", "chat:write"],
        },
      ])

      const request = createMockRequest({ authorization: "Bearer eyJhdGVzdC5qd3Q" })
      const result = await authenticateRequest(request as never)

      // The fix: jwtVerify is now called with { issuer, audience } (was signature-only),
      // so ID tokens / wrong-audience tokens signed by the same key are rejected.
      expect(mockJwtVerify).toHaveBeenCalledWith(
        "eyJhdGVzdC5qd3Q",
        expect.anything(),
        { issuer: "https://issuer.example", audience: "https://issuer.example" }
      )
      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.authType).toBe("jwt")
      expect(auth.scopes).toEqual(["chat:read", "chat:write"])
    })

    it("returns 401 when verify rejects on an iss/aud mismatch (REV-SEC-164)", async () => {
      mockJwtVerify.mockRejectedValue(new Error('unexpected "aud" claim value'))

      const request = createMockRequest({ authorization: "Bearer eyJ3cm9uZy5hdWQ" })
      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
      expect(mockGetServerSession).not.toHaveBeenCalled()
    })

    it("returns 401 for an expired signed token", async () => {
      mockJwtVerify.mockRejectedValue(new Error('"exp" claim timestamp check failed'))

      const result = await authenticateRequest(
        createMockRequest({
          authorization: "Bearer eyJleHBpcmVkLnRva2Vu",
        }) as never
      )

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
    })

    it("returns 401 when a valid JWT has been revoked or its client is inactive", async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: "5",
          jti: "revoked-token",
          scope: "chat:read",
          client_id: "agent-1",
        },
      })
      mockExecuteQuery.mockResolvedValue([])

      const result = await authenticateRequest(
        createMockRequest({
          authorization: "Bearer eyJyZXZva2VkLnRva2Vu",
        }) as never
      )

      expect(isAuthContext(result)).toBe(false)
      expect((result as unknown as { status: number }).status).toBe(401)
    })

    it("rejects non-canonical numeric subjects", async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          sub: "5garbage",
          jti: "token-1",
          scope: "chat:read",
          client_id: "agent-1",
        },
      })

      const result = await authenticateRequest(
        createMockRequest({
          authorization: "Bearer eyJiYWQuc3Vi",
        }) as never
      )

      expect(isAuthContext(result)).toBe(false)
      expect(mockExecuteQuery).not.toHaveBeenCalled()
    })
  })

  describe("requireScope", () => {
    it("should return null when scope matches", () => {
      mockHasScope.mockReturnValue(true)

      const auth = {
        userId: 42,
        cognitoSub: "test",
        authType: "api_key" as const,
        scopes: ["chat:read"],
        apiKeyId: 1,
      }

      const result = requireScope(auth, "chat:read")
      expect(result).toBeNull()
    })

    it("should return 403 when scope is missing", () => {
      mockHasScope.mockReturnValue(false)

      const auth = {
        userId: 42,
        cognitoSub: "test",
        authType: "api_key" as const,
        scopes: ["chat:read"],
        apiKeyId: 1,
      }

      const result = requireScope(auth, "chat:write")
      expect(result).not.toBeNull()
      expect((result as unknown as { status: number }).status).toBe(403)
    })

    it("should always pass for session users with wildcard scopes", () => {
      mockHasScope.mockReturnValue(true) // hasScope(["*"], anything) returns true

      const auth = {
        userId: 42,
        cognitoSub: "test",
        authType: "session" as const,
        scopes: ["*"],
      }

      const result = requireScope(auth, "any:scope")
      expect(result).toBeNull()
    })

    it("should include scope info in 403 response", async () => {
      mockHasScope.mockReturnValue(false)

      const auth = {
        userId: 42,
        cognitoSub: "test",
        authType: "api_key" as const,
        scopes: ["chat:read"],
        apiKeyId: 1,
      }

      const result = requireScope(auth, "admin:write")
      expect(result).not.toBeNull()
      const body = await (result as unknown as { json: () => Promise<{ error: { code: string; message: string } }> }).json()
      expect(body.error.code).toBe("INSUFFICIENT_SCOPE")
      expect(body.error.message).toContain("admin:write")
    })
  })

  // ------------------------------------------
  // Error Response Formatting
  // ------------------------------------------
  describe("createErrorResponse", () => {
    it("should include requestId in body and header", async () => {
      const response = createErrorResponse(
        "req-123",
        401,
        "UNAUTHORIZED",
        "Auth required"
      )

      expect(response.status).toBe(401)
      expect(response.headers.get("X-Request-Id")).toBe("req-123")

      const body = await response.json()
      expect(body.requestId).toBe("req-123")
      expect(body.error.code).toBe("UNAUTHORIZED")
      expect(body.error.message).toBe("Auth required")
    })

    it("should include details when provided", async () => {
      const response = createErrorResponse(
        "req-456",
        400,
        "BAD_REQUEST",
        "Invalid input",
        { field: "name" }
      )

      const body = await response.json()
      expect(body.error.details).toEqual({ field: "name" })
    })

    it("should omit details when not provided", async () => {
      const response = createErrorResponse(
        "req-789",
        500,
        "INTERNAL_ERROR",
        "Something failed"
      )

      const body = await response.json()
      expect(body.error.details).toBeUndefined()
    })
  })

  // ------------------------------------------
  // Success Response Formatting
  // ------------------------------------------
  describe("createApiResponse", () => {
    it("should include X-Request-Id header", () => {
      const response = createApiResponse({ message: "ok" }, "req-abc")

      expect(response.status).toBe(200)
      expect(response.headers.get("X-Request-Id")).toBe("req-abc")
    })

    it("should use custom status code", () => {
      const response = createApiResponse({ id: 1 }, "req-def", 201)

      expect(response.status).toBe(201)
    })
  })
})
