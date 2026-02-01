/**
 * Unit tests for withApiAuth higher-order function
 * Tests the full middleware composition: auth → rate limit → handler → usage logging.
 *
 * @see lib/api/with-api-auth.ts
 * Issue #677 - API authentication middleware
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, jest } from "@jest/globals"
import { NextResponse } from "next/server"

// ============================================
// Mocks
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

const mockAuthenticateRequest = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockCreateErrorResponse = jest.fn<(...args: unknown[]) => unknown>(
  (...args: unknown[]) => {
    const [requestId, status, code, message] = args
    return NextResponse.json(
      { error: { code, message }, requestId },
      { status: status as number }
    )
  }
)

jest.mock("@/lib/api/auth-middleware", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
}))

const mockCheckRateLimit = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockCreateRateLimitResponse = jest.fn<(...args: unknown[]) => unknown>()
const mockAddRateLimitHeaders = jest.fn<(...args: unknown[]) => void>()
const mockRecordUsage = jest.fn<(...args: unknown[]) => void>()

jest.mock("@/lib/api/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimitResponse: (...args: unknown[]) => mockCreateRateLimitResponse(...args),
  addRateLimitHeaders: (...args: unknown[]) => mockAddRateLimitHeaders(...args),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}))

// Import after mocks — use require() to ensure mocks are registered first
// (next/jest SWC transform may not properly hoist jest.mock before static imports)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withApiAuth } = require("@/lib/api/with-api-auth")
import type { ApiAuthContext } from "@/lib/api/auth-middleware"

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

const mockAuth: ApiAuthContext = {
  userId: 42,
  cognitoSub: "test-sub",
  authType: "api_key",
  scopes: ["chat:read"],
  apiKeyId: 7,
}

function createMockRequest(
  url: string = "http://localhost:3000/api/v1/test",
  method: string = "GET"
): Request {
  return new Request(url, { method })
}

// ============================================
// Tests
// ============================================

describe("withApiAuth", () => {
  beforeEach(() => {
    jest.clearAllMocks()

    // Default: auth succeeds, rate limit passes
    mockAuthenticateRequest.mockResolvedValue(mockAuth)
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 55,
      resetAt: Math.ceil(Date.now() / 1000) + 60,
    })
  })

  // ------------------------------------------
  // Successful request flow
  // ------------------------------------------
  describe("successful request flow", () => {
    it("should call handler with auth context and requestId", async () => {
      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(
        NextResponse.json({ data: "success" })
      )

      const wrappedHandler = withApiAuth(handler)
      const request = createMockRequest()
      await wrappedHandler(request as never)

      expect(handler).toHaveBeenCalledWith(
        request,
        mockAuth,
        expect.any(String) // requestId
      )
    })

    it("should add X-Request-Id to successful response", async () => {
      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(
        NextResponse.json({ data: "ok" })
      )

      const wrappedHandler = withApiAuth(handler)
      const response = await wrappedHandler(createMockRequest() as never)

      expect(response.headers.get("X-Request-Id")).toBeDefined()
      expect(response.headers.get("X-Request-Id")).not.toBe("")
    })

    it("should add rate limit headers to response", async () => {
      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(
        NextResponse.json({ data: "ok" })
      )

      const wrappedHandler = withApiAuth(handler)
      await wrappedHandler(createMockRequest() as never)

      expect(mockAddRateLimitHeaders).toHaveBeenCalled()
    })

    it("should record usage after response", async () => {
      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(
        NextResponse.json({ data: "ok" }, { status: 200 })
      )

      const wrappedHandler = withApiAuth(handler)
      await wrappedHandler(createMockRequest() as never)

      expect(mockRecordUsage).toHaveBeenCalledWith(
        mockAuth,
        expect.anything(), // request
        200, // statusCode
        expect.any(Number) // responseTimeMs
      )
    })
  })

  // ------------------------------------------
  // Auth failure short-circuit
  // ------------------------------------------
  describe("auth failure", () => {
    it("should return error response without calling handler", async () => {
      // authenticateRequest returns an error response (not an ApiAuthContext)
      const authError = { status: 401, headers: new Map(), json: async () => ({ error: { code: "UNAUTHORIZED" } }) }
      mockAuthenticateRequest.mockResolvedValue(authError)

      const handler = jest.fn()
      const wrappedHandler = withApiAuth(handler)
      const response = await wrappedHandler(createMockRequest() as never)

      expect(response.status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
    })

    it("should not check rate limit on auth failure", async () => {
      mockAuthenticateRequest.mockResolvedValue(
        { status: 401, headers: new Map(), json: async () => ({}) }
      )

      const wrappedHandler = withApiAuth(jest.fn())
      await wrappedHandler(createMockRequest() as never)

      expect(mockCheckRateLimit).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------
  // Rate limit short-circuit
  // ------------------------------------------
  describe("rate limit exceeded", () => {
    it("should return 429 without calling handler", async () => {
      mockCheckRateLimit.mockResolvedValue({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: Math.ceil(Date.now() / 1000) + 60,
        retryAfterSeconds: 30,
      })

      const rateLimitResponse = NextResponse.json(
        { error: { code: "RATE_LIMIT_EXCEEDED" } },
        { status: 429 }
      )
      mockCreateRateLimitResponse.mockReturnValue(rateLimitResponse)

      const handler = jest.fn()
      const wrappedHandler = withApiAuth(handler)
      const response = await wrappedHandler(createMockRequest() as never)

      expect(response.status).toBe(429)
      expect(handler).not.toHaveBeenCalled()
    })

    it("should record usage with 429 status on rate limit", async () => {
      mockCheckRateLimit.mockResolvedValue({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: 0,
        retryAfterSeconds: 60,
      })
      mockCreateRateLimitResponse.mockReturnValue(
        NextResponse.json({}, { status: 429 })
      )

      const wrappedHandler = withApiAuth(jest.fn())
      await wrappedHandler(createMockRequest() as never)

      expect(mockRecordUsage).toHaveBeenCalledWith(
        mockAuth,
        expect.anything(),
        429,
        expect.any(Number)
      )
    })
  })

  // ------------------------------------------
  // Handler error handling
  // ------------------------------------------
  describe("handler errors", () => {
    it("should catch unhandled errors and return 500", async () => {
      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error("Unexpected crash"))

      const wrappedHandler = withApiAuth(handler)
      const response = await wrappedHandler(createMockRequest() as never)

      expect(response.status).toBe(500)
      expect(mockCreateErrorResponse).toHaveBeenCalledWith(
        expect.any(String),
        500,
        "INTERNAL_ERROR",
        "An unexpected error occurred"
      )
    })

    it("should still record usage when handler throws", async () => {
      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error("Crash"))

      const wrappedHandler = withApiAuth(handler)
      await wrappedHandler(createMockRequest() as never)

      expect(mockRecordUsage).toHaveBeenCalledWith(
        mockAuth,
        expect.anything(),
        500,
        expect.any(Number)
      )
    })
  })

  // ------------------------------------------
  // Execution order
  // ------------------------------------------
  describe("middleware execution order", () => {
    it("should execute auth → rate limit → handler → record usage", async () => {
      const callOrder: string[] = []

      mockAuthenticateRequest.mockImplementation(async () => {
        callOrder.push("auth")
        return mockAuth
      })

      mockCheckRateLimit.mockImplementation(async () => {
        callOrder.push("rateLimit")
        return { allowed: true, limit: 60, remaining: 55, resetAt: 0 }
      })

      const handler = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async () => {
        callOrder.push("handler")
        return NextResponse.json({ ok: true })
      })

      mockRecordUsage.mockImplementation(() => {
        callOrder.push("recordUsage")
      })

      const wrappedHandler = withApiAuth(handler)
      await wrappedHandler(createMockRequest() as never)

      expect(callOrder).toEqual(["auth", "rateLimit", "handler", "recordUsage"])
    })
  })
})
