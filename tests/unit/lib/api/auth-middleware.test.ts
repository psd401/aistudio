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

const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>()
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))

jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  users: { id: "id", cognitoSub: "cognito_sub" },
}))

// Import after mocks — use require() to ensure mocks are registered first
// (next/jest SWC transform may not properly hoist jest.mock before static imports)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticateRequest, requireScope, createErrorResponse, createApiResponse } = require("@/lib/api/auth-middleware")

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
    it("should authenticate via session when no Authorization header", async () => {
      mockGetServerSession.mockResolvedValue({
        sub: "test-cognito-sub",
        email: "test@example.com",
      })
      mockGetUserIdByCognitoSubAsNumber.mockResolvedValue(42)

      const request = createMockRequest({})

      const result = await authenticateRequest(request as never)

      expect(isAuthContext(result)).toBe(true)
      const auth = result as Exclude<typeof result, NextResponse>
      expect(auth.userId).toBe(42)
      expect(auth.authType).toBe("session")
      expect(auth.scopes).toEqual(["*"])
      expect(auth.cognitoSub).toBe("test-cognito-sub")
      expect(auth.apiKeyId).toBeUndefined()
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
