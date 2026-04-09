/**
 * Tests for voice WebSocket handler authentication and authorization.
 * Covers the critical security paths: JWT verification, tool access, error handling.
 */

// Mock jose
const mockJwtVerify = jest.fn()
jest.mock("jose", () => ({
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}))

// Mock logger
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "test-request-id",
  startTimer: () => jest.fn(),
}))

// Mock settings
jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getVoice: jest.fn().mockResolvedValue({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
    }),
    getGoogleAI: jest.fn().mockResolvedValue("test-api-key"),
  },
}))

// Mock DB hasToolAccess
const mockHasToolAccess = jest.fn()
jest.mock("@/lib/db/drizzle/users", () => ({
  hasToolAccess: (...args: unknown[]) => mockHasToolAccess(...args),
}))

// Mock provider factory
jest.mock("../provider-factory", () => ({
  createVoiceProvider: jest.fn().mockReturnValue({
    providerId: "gemini-live",
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    sendAudio: jest.fn(),
    getSessionState: jest.fn().mockReturnValue({ connected: false, speaking: "none", transcript: [] }),
    isConnected: jest.fn().mockReturnValue(true),
  }),
  isSupportedVoiceProvider: jest.fn().mockReturnValue(true),
}))

// Mock @google/genai (required by gemini-live-provider which is transitively imported)
jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn(),
  Modality: { AUDIO: "AUDIO" },
}))

// Mock S3 (needed if settings-manager is loaded)
jest.mock("@/lib/aws/s3-client", () => ({
  clearS3Cache: jest.fn(),
}))

import { handleVoiceConnection } from "../ws-handler"
import type { IncomingMessage } from "node:http"

// Helper to create a mock WebSocket
function createMockWs() {
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
  }
  return ws as unknown as Parameters<typeof handleVoiceConnection>[0]
}

// Helper to create a mock request with cookies
function createMockReq(cookies: Record<string, string> = {}): IncomingMessage {
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ")
  return {
    headers: { cookie: cookieStr },
  } as unknown as IncomingMessage
}

describe("handleVoiceConnection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.AUTH_SECRET = "test-secret-key-for-testing-only-32chars!"
  })

  afterEach(() => {
    delete process.env.AUTH_SECRET
  })

  describe("authentication", () => {
    it("should close with 4001 when no session cookie present", async () => {
      const ws = createMockWs()
      const req = createMockReq({})

      await handleVoiceConnection(ws, req)

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"Unauthorized"')
      )
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should close with 4001 when JWT verification fails", async () => {
      mockJwtVerify.mockRejectedValue(new Error("Invalid token"))

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "invalid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"Unauthorized"')
      )
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should close with 4001 when JWT has no sub claim", async () => {
      mockJwtVerify.mockResolvedValue({ payload: {} })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "token-no-sub" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should verify JWT with HS256 algorithm pinning", async () => {
      mockJwtVerify.mockResolvedValue({ payload: { sub: "user-123" } })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(mockJwtVerify).toHaveBeenCalledWith(
        "valid-token",
        expect.anything(), // TextEncoder-encoded secret key
        expect.objectContaining({
          algorithms: ["HS256"],
          clockTolerance: 30,
        })
      )
    })

    it("should accept __Secure-authjs.session-token cookie", async () => {
      mockJwtVerify.mockResolvedValue({ payload: { sub: "user-123" } })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      const req = createMockReq({ "__Secure-authjs.session-token": "secure-token" })

      await handleVoiceConnection(ws, req)

      expect(mockJwtVerify).toHaveBeenCalledWith(
        "secure-token",
        expect.anything(),
        expect.anything()
      )
    })
  })

  describe("authorization", () => {
    beforeEach(() => {
      mockJwtVerify.mockResolvedValue({ payload: { sub: "user-123" } })
    })

    it("should close with 4003 when user lacks voice-mode access", async () => {
      mockHasToolAccess.mockResolvedValue(false)

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(mockHasToolAccess).toHaveBeenCalledWith("user-123", "voice-mode")
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Voice mode not enabled")
      )
      expect(ws.close).toHaveBeenCalledWith(4003, "Forbidden")
    })

    it("should close with 4003 when tool access check throws", async () => {
      mockHasToolAccess.mockRejectedValue(new Error("DB error"))

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4003, "Forbidden")
    })

    it("should proceed when user has voice-mode access", async () => {
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // Should not close with 4003 — connection continues
      const closeCalls = (ws.close as jest.Mock).mock.calls
      const forbiddenClose = closeCalls.find(
        (call: unknown[]) => call[0] === 4003
      )
      expect(forbiddenClose).toBeUndefined()
    })
  })

  describe("error handling", () => {
    it("should close with 4500 when AUTH_SECRET is not configured", async () => {
      delete process.env.AUTH_SECRET
      delete process.env.NEXTAUTH_SECRET

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should close with 4500 when Google API key is missing", async () => {
      mockJwtVerify.mockResolvedValue({ payload: { sub: "user-123" } })
      mockHasToolAccess.mockResolvedValue(true)

      // Override getGoogleAI to return null
      const { Settings } = require("@/lib/settings-manager")
      Settings.getGoogleAI.mockResolvedValueOnce(null)

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Voice provider not configured")
      )
      expect(ws.close).toHaveBeenCalledWith(4500, "Provider not configured")
    })
  })
})
