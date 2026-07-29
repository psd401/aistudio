/**
 * Unit tests for Per-Key API Rate Limiter
 * Tests sliding window rate limiting, per-key custom limits,
 * usage recording, and fail-open behavior.
 *
 * @see lib/api/rate-limiter.ts
 * Issue #677 - API authentication middleware
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, jest } from "@jest/globals"

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

const mockExecuteQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockExecuteTransaction = jest.fn<(...args: unknown[]) => Promise<unknown>>()
let mockReservationCount = 0

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
  executeTransaction: (...args: unknown[]) => mockExecuteTransaction(...args),
}))

jest.mock("@/lib/db/schema", () => ({
  apiKeyUsage: {
    id: "id",
    apiKeyId: "api_key_id",
    endpoint: "endpoint",
    method: "method",
    statusCode: "status_code",
    requestAt: "request_at",
    responseTimeMs: "response_time_ms",
    ipAddress: "ip_address",
  },
  apiKeys: {
    id: "id",
    rateLimitRpm: "rate_limit_rpm",
  },
  apiRateLimitReservations: {
    principalHash: "principal_hash",
    endpoint: "endpoint",
    requestAt: "request_at",
  },
}))

jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  eq: jest.fn(),
  count: jest.fn(),
  gte: jest.fn(),
  lt: jest.fn(),
  sql: jest.fn((parts: TemplateStringsArray) => parts.join("?")),
}))

const mockCreateErrorResponse = jest.fn<(...args: unknown[]) => unknown>(
  (...args: unknown[]) => {
    const [requestId, status, code, message] = args

    const { NextResponse: NR } = require("next/server")
    return NR.json({ error: { code, message }, requestId }, { status: status as number })
  }
)

jest.mock("@/lib/api/auth-middleware", () => ({
  createErrorResponse: (...args: unknown[]) => mockCreateErrorResponse(...args),
}))

// Import after mocks — use require() to ensure mocks are registered first
// (next/jest SWC transform may not properly hoist jest.mock before static imports)

const {
  checkRateLimit,
  createRateLimitResponse,
  addRateLimitHeaders,
  recordUsage,
  fingerprintRateLimitPrincipal,
} = require("@/lib/api/rate-limiter")
import type { ApiAuthContext } from "@/lib/api/auth-middleware"

const { NextResponse } = require("next/server")

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

function createApiKeyAuth(overrides: Partial<ApiAuthContext> = {}): ApiAuthContext {
  return {
    userId: 42,
    cognitoSub: "test-sub",
    authType: "api_key",
    scopes: ["chat:read"],
    apiKeyId: 7,
    ...overrides,
  }
}

function createSessionAuth(overrides: Partial<ApiAuthContext> = {}): ApiAuthContext {
  return {
    userId: 42,
    cognitoSub: "test-sub",
    authType: "session",
    scopes: ["*"],
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

function createTransaction() {
    return {
      execute: jest.fn(async () => []),
      delete: jest.fn(() => ({ where: jest.fn(async () => []) })),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(async () => [{ value: mockReservationCount }]),
        })),
      })),
      insert: jest.fn(() => ({ values: jest.fn(async () => []) })),
    }
  }

function defineRateLimiterSuite1Part1() {


  beforeEach(() => {
    jest.clearAllMocks()
    mockReservationCount = 0
    mockExecuteTransaction.mockImplementation(async (callback: unknown) => {
      const tx = createTransaction()
      return (callback as (value: typeof tx) => Promise<unknown>)(tx)
    })
  })

  // ------------------------------------------
  // checkRateLimit
  // ------------------------------------------

    it("creates stable, domain-separated principal fingerprints", () => {
      const apiKey = fingerprintRateLimitPrincipal("api_key:42")
      expect(apiKey).toHaveLength(36)
      expect(fingerprintRateLimitPrincipal("api_key:42")).toBe(apiKey)
      expect(fingerprintRateLimitPrincipal("session:42")).not.toBe(apiKey)
    })

    it("should allow requests within limit", async () => {
      // First call: get rate limit config
      mockExecuteQuery.mockResolvedValueOnce([{ rateLimitRpm: 60 }])
      mockReservationCount = 30

      const result = await checkRateLimit(createApiKeyAuth())

      expect(result.allowed).toBe(true)
      expect(result.limit).toBe(60)
      expect(result.remaining).toBe(29) // 60 - 30 - 1 (current)
      // The typed operator applies the timestamp column encoder. A raw SQL
      // interpolation passes Date directly to postgres.js and fails closed.

      const { gte } = require("drizzle-orm") as { gte: jest.Mock }
      expect(gte).toHaveBeenCalledWith(
        "request_at",
        expect.any(Date)
      )
    })

    it("should deny requests exceeding limit", async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ rateLimitRpm: 60 }])
      mockReservationCount = 60

      const result = await checkRateLimit(createApiKeyAuth())

      expect(result.allowed).toBe(false)
      expect(result.limit).toBe(60)
      expect(result.remaining).toBe(0)
      expect(result.retryAfterSeconds).toBeDefined()
      expect(result.retryAfterSeconds).toBeGreaterThan(0)
    })

    it("should allow exactly N-1 requests when limit is N", async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ rateLimitRpm: 60 }])
      mockReservationCount = 59

      const result = await checkRateLimit(createApiKeyAuth())

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(0) // 60 - 59 - 1
    })

    it("should deny at exactly N requests", async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ rateLimitRpm: 60 }])
      mockReservationCount = 60

      const result = await checkRateLimit(createApiKeyAuth())

      expect(result.allowed).toBe(false)
    })

    it("should use per-key rate_limit_rpm when set", async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ rateLimitRpm: 20 }])
      mockReservationCount = 15

      const result = await checkRateLimit(createApiKeyAuth())

      expect(result.limit).toBe(20)
      expect(result.remaining).toBe(4) // 20 - 15 - 1
    })

    it("should use default 60 RPM when rate_limit_rpm is null", async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ rateLimitRpm: null }])
      mockReservationCount = 10

      const result = await checkRateLimit(createApiKeyAuth())

      expect(result.limit).toBe(60)
    })

    it("should durably rate limit session auth", async () => {
      const result = await checkRateLimit(createSessionAuth())

      expect(result.allowed).toBe(true)
      expect(result.limit).toBe(60)
      expect(mockExecuteQuery).not.toHaveBeenCalled()
      expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    })

    it("should apply the default durable limit when no apiKeyId is present", async () => {
      const auth = createApiKeyAuth({ apiKeyId: undefined })

      const result = await checkRateLimit(auth)

      expect(result.allowed).toBe(true)
      expect(mockExecuteQuery).not.toHaveBeenCalled()
      expect(mockExecuteTransaction).toHaveBeenCalledTimes(1)
    })

    }

function defineRateLimiterSuite1Part2() {it("should fail closed when database errors", async () => {
      mockExecuteQuery.mockRejectedValueOnce(new Error("DB connection failed"))

      const result = await checkRateLimit(createApiKeyAuth())

      // Should deny the request on error (fail-closed for security)
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.retryAfterSeconds).toBe(60)
    })

    it("should handle empty key config result", async () => {
      mockExecuteQuery.mockResolvedValueOnce([]) // no config found
      mockReservationCount = 10

      const result = await checkRateLimit(createApiKeyAuth())

      // Should fall back to default RPM
      expect(result.limit).toBe(60)
      expect(result.allowed).toBe(true)
    })


  // ------------------------------------------
  // createRateLimitResponse
  // ------------------------------------------

    it("should return 429 with rate limit headers", () => {
      const rateLimitResult = {
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: Math.ceil(Date.now() / 1000) + 60,
        retryAfterSeconds: 45,
      }

      const response = createRateLimitResponse("req-123", rateLimitResult)

      expect(response.status).toBe(429)
      expect(response.headers.get("Retry-After")).toBe("45")
      expect(response.headers.get("X-RateLimit-Limit")).toBe("60")
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0")
      expect(response.headers.get("X-RateLimit-Reset")).toBeDefined()
    })

    it("should default Retry-After to 60 when not specified", () => {
      const rateLimitResult = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetAt: Math.ceil(Date.now() / 1000) + 60,
      }

      const response = createRateLimitResponse("req-456", rateLimitResult)

      expect(response.headers.get("Retry-After")).toBe("60")
    })


  // ------------------------------------------
  // addRateLimitHeaders
  // ------------------------------------------

    it("should add headers to response when limit > 0", () => {
      const response = NextResponse.json({ data: "ok" })
      const rateLimitResult = {
        allowed: true,
        limit: 60,
        remaining: 45,
        resetAt: 1706745600,
      }

      addRateLimitHeaders(response as never, rateLimitResult)

      expect(response.headers.get("X-RateLimit-Limit")).toBe("60")
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("45")
      expect(response.headers.get("X-RateLimit-Reset")).toBe("1706745600")
    })

    it("should not add headers when limit is 0 (session auth)", () => {
      const response = NextResponse.json({ data: "ok" })
      const rateLimitResult = {
        allowed: true,
        limit: 0,
        remaining: 0,
        resetAt: 0,
      }

      addRateLimitHeaders(response as never, rateLimitResult)

      // Map.get returns undefined for missing keys (not null like real Headers)
      expect(response.headers.get("X-RateLimit-Limit")).toBeFalsy()
    })


  // ------------------------------------------
  // recordUsage
  // ------------------------------------------

    }

function defineRateLimiterSuite1Part3() {it("should record usage for API key auth", () => {
      mockExecuteQuery.mockResolvedValue([])

      const request = new Request("http://localhost:3000/api/v1/chat", {
        method: "POST",
        headers: { "x-forwarded-for": "192.168.1.1" },
      })

      recordUsage(createApiKeyAuth(), request as never, 200, 150)

      // executeQuery should be called (fire-and-forget)
      expect(mockExecuteQuery).toHaveBeenCalled()
    })

    it("should not record usage for session auth", () => {
      const request = new Request("http://localhost:3000/api/v1/chat", {
        method: "GET",
      })

      recordUsage(createSessionAuth(), request as never, 200, 100)

      expect(mockExecuteQuery).not.toHaveBeenCalled()
    })

    it("should not record usage when apiKeyId is missing", () => {
      const auth = createApiKeyAuth({ apiKeyId: undefined })
      const request = new Request("http://localhost:3000/api/v1/chat", {
        method: "GET",
      })

      recordUsage(auth, request as never, 200, 100)

      expect(mockExecuteQuery).not.toHaveBeenCalled()
    })

    it("should not throw when recording fails", () => {
      mockExecuteQuery.mockRejectedValue(new Error("Insert failed"))

      const request = new Request("http://localhost:3000/api/v1/chat", {
        method: "POST",
      })

      // Should not throw
      expect(() => {
        recordUsage(createApiKeyAuth(), request as never, 200, 150)
      }).not.toThrow()
    })

}

const defineRateLimiterSuite1 = () => {
  defineRateLimiterSuite1Part1()
  defineRateLimiterSuite1Part2()
  defineRateLimiterSuite1Part3()
};

describe("Rate Limiter", defineRateLimiterSuite1)
