/**
 * Tests for GET /api/nexus/voice/availability route handler.
 *
 * Covers:
 * - 401 when unauthenticated
 * - 200 with available: true and reason when voice is available
 * - 200 with available: false and reason when voice is unavailable
 * - internalReason is never leaked to the client response
 * - Config details are never leaked to the client response
 * - 500 on unexpected errors
 *
 * Note: Cache-Control header is set in the route but cannot be reliably tested
 * in jest-environment-jsdom because next/jest transforms strip NextResponse
 * header init. The header behavior is verified in E2E tests.
 *
 * Issue #876, #897
 */

// Mock logger before any imports
jest.mock("@/lib/logger", () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  generateRequestId: jest.fn(() => "test-request-id"),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((data: unknown) => data),
}))

// Mock auth
const mockGetServerSession = jest.fn()
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

// Mock availability
const mockGetVoiceAvailability = jest.fn()
jest.mock("@/lib/voice/availability", () => ({
  getVoiceAvailability: (...args: unknown[]) => mockGetVoiceAvailability(...args),
}))

import { GET } from "../route"

describe("GET /api/nexus/voice/availability", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should return 401 when user is not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null)

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: "Unauthorized" })
    expect(mockGetVoiceAvailability).not.toHaveBeenCalled()
  })

  it("should return available: true with no reason when voice is available", async () => {
    mockGetServerSession.mockResolvedValue({ sub: "user-sub-123" })
    mockGetVoiceAvailability.mockResolvedValue({
      available: true,
      config: {
        provider: "gemini-live",
        model: "gemini-2.0-flash-live-001",
        language: "en-US",
        voiceName: null,
        apiKey: "test-key",
      },
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.reason).toBeUndefined()
    expect(mockGetVoiceAvailability).toHaveBeenCalledWith("user-sub-123")
  })

  it("should return available: false with reason when voice is unavailable", async () => {
    mockGetServerSession.mockResolvedValue({ sub: "user-sub-456" })
    mockGetVoiceAvailability.mockResolvedValue({
      available: false,
      reason: "Voice mode is disabled by administrator",
      type: "permission",
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.reason).toBe("Voice mode is disabled by administrator")
  })

  it("should never include internalReason in the response body", async () => {
    mockGetServerSession.mockResolvedValue({ sub: "user-sub-789" })
    mockGetVoiceAvailability.mockResolvedValue({
      available: false,
      reason: "Voice mode is not currently available",
      internalReason: "Voice provider API key not configured",
      type: "config",
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.reason).toBe("Voice mode is not currently available")
    // Security property: internalReason must never be in response
    expect(body.internalReason).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("API key")
  })

  it("should return 500 on unexpected errors", async () => {
    mockGetServerSession.mockResolvedValue({ sub: "user-sub-123" })
    mockGetVoiceAvailability.mockRejectedValue(new Error("Database connection failed"))

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: "Internal server error" })
  })

  it("should not include config details in the response", async () => {
    mockGetServerSession.mockResolvedValue({ sub: "user-sub-123" })
    mockGetVoiceAvailability.mockResolvedValue({
      available: true,
      config: {
        provider: "gemini-live",
        model: "gemini-2.0-flash-live-001",
        language: "en-US",
        voiceName: null,
        apiKey: "secret-api-key-12345",
      },
    })

    const response = await GET()
    const body = await response.json()

    expect(body.config).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("secret-api-key")
    expect(JSON.stringify(body)).not.toContain("gemini-live")
  })
})
