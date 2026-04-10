/**
 * Tests for voice WebSocket handler authentication and authorization.
 * Covers the critical security paths: Auth.js JWT decryption, tool access, error handling.
 */

// Mock @auth/core/jwt (Auth.js uses encrypted JWTs, not signed)
const mockDecode = jest.fn()
jest.mock("@auth/core/jwt", () => ({
  decode: (...args: unknown[]) => mockDecode(...args),
}))

// Mock constants with short timeout for tests
jest.mock("../constants", () => ({
  MAX_AUDIO_DATA_LENGTH: 131_072,
  PROVIDER_CONNECT_TIMEOUT_MS: 200, // 200ms instead of 30s for test speed
  MIN_AUDIO_INTERVAL_MS: 20,
  PING_INTERVAL_MS: 240_000,
  WS_OPEN: 1,
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
  sanitizeForLogging: (v: unknown) => v,
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

// Mock @google/genai (required by gemini-live-provider transitively)
jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn(),
  Modality: { AUDIO: "AUDIO" },
}))

// Mock S3
jest.mock("@/lib/aws/s3-client", () => ({
  clearS3Cache: jest.fn(),
}))

import { handleVoiceConnection } from "../ws-handler"
import type { IncomingMessage } from "node:http"

// Helper to create a mock WebSocket
function createMockWs() {
  const ws = {
    readyState: 1, // OPEN
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    ping: jest.fn(),
    removeAllListeners: jest.fn(),
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

    it("should close with 4001 when Auth.js decode fails", async () => {
      mockDecode.mockRejectedValue(new Error("Decryption failed"))

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "invalid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"Unauthorized"')
      )
      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should close with 4001 when decoded token has no sub claim", async () => {
      mockDecode.mockResolvedValue({ email: "test@example.com" })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "token-no-sub" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should close with 4001 when decode returns null", async () => {
      mockDecode.mockResolvedValue(null)

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "expired-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should use @auth/core/jwt decode with correct salt and secret", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "encrypted-token" })

      await handleVoiceConnection(ws, req)

      expect(mockDecode).toHaveBeenCalledWith({
        token: "encrypted-token",
        salt: "authjs.session-token",
        secret: "test-secret-key-for-testing-only-32chars!",
      })
    })

    it("should handle __Secure- prefixed cookies", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      const req = createMockReq({ "__Secure-authjs.session-token": "secure-token" })

      await handleVoiceConnection(ws, req)

      expect(mockDecode).toHaveBeenCalledWith({
        token: "secure-token",
        salt: "__Secure-authjs.session-token",
        secret: expect.any(String),
      })
    })

    it("should reassemble chunked session cookies", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      const req = createMockReq({
        "authjs.session-token.0": "chunk1",
        "authjs.session-token.1": "chunk2",
        "authjs.session-token.2": "chunk3",
      })

      await handleVoiceConnection(ws, req)

      expect(mockDecode).toHaveBeenCalledWith({
        token: "chunk1chunk2chunk3",
        salt: "authjs.session-token",
        secret: expect.any(String),
      })
    })
  })

  describe("authorization", () => {
    beforeEach(() => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
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

    it("should close with 4003 when tool access check throws (fail-closed)", async () => {
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

      // Should not close with 4003
      const closeCalls = (ws.close as jest.Mock).mock.calls
      const forbiddenClose = closeCalls.find(
        (call: unknown[]) => call[0] === 4003
      )
      expect(forbiddenClose).toBeUndefined()
    })
  })

  describe("error handling", () => {
    it("should close with 4001 when AUTH_SECRET is not configured", async () => {
      delete process.env.AUTH_SECRET
      delete process.env.NEXTAUTH_SECRET

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4001, "Unauthorized")
    })

    it("should close with 4500 when Google API key is missing", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

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

    it("should close with 4500 when provider.connect() times out", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      // Mock connect that hangs but rejects when aborted (via AbortSignal)
      const { createVoiceProvider } = require("../provider-factory")
      createVoiceProvider.mockReturnValueOnce({
        providerId: "gemini-live",
        connect: jest.fn().mockImplementation(
          (_config: unknown, _onEvent: unknown, signal?: AbortSignal) =>
            new Promise((_, reject) => {
              if (signal) {
                signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
              }
            })
        ),
        disconnect: jest.fn().mockResolvedValue(undefined),
        sendAudio: jest.fn(),
        getSessionState: jest.fn(),
        isConnected: jest.fn().mockReturnValue(false),
      })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4500, "Internal error")
    }, 5_000)

    it("should remove listeners on connect failure", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      const { createVoiceProvider } = require("../provider-factory")
      createVoiceProvider.mockReturnValueOnce({
        providerId: "gemini-live",
        connect: jest.fn().mockRejectedValue(new Error("SDK error")),
        disconnect: jest.fn().mockResolvedValue(undefined),
        sendAudio: jest.fn(),
        getSessionState: jest.fn(),
        isConnected: jest.fn(),
      })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.removeAllListeners).toHaveBeenCalledWith("message")
      expect(ws.removeAllListeners).toHaveBeenCalledWith("close")
      expect(ws.removeAllListeners).toHaveBeenCalledWith("error")
    })
  })

  describe("message handling", () => {
    let messageHandler: (data: Buffer) => void

    beforeEach(() => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)
    })

    /** Connect and extract the registered message handler from ws.on("message", ...) */
    async function connectAndGetMessageHandler() {
      const ws = createMockWs()
      const handlers: Record<string, (...args: unknown[]) => void> = {}
      ;(ws.on as jest.Mock).mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler
        return ws
      })

      const req = createMockReq({ "authjs.session-token": "valid-token" })
      await handleVoiceConnection(ws, req)

      messageHandler = handlers["message"] as (data: Buffer) => void
      return { ws, handlers }
    }

    it("should register close/error handlers before message handler", async () => {
      const ws = createMockWs()
      const registrationOrder: string[] = []
      ;(ws.on as jest.Mock).mockImplementation((event: string) => {
        registrationOrder.push(event)
        return ws
      })

      await handleVoiceConnection(ws, createMockReq({ "authjs.session-token": "valid-token" }))

      const closeIdx = registrationOrder.indexOf("close")
      const errorIdx = registrationOrder.indexOf("error")
      const messageIdx = registrationOrder.indexOf("message")
      expect(closeIdx).toBeLessThan(messageIdx)
      expect(errorIdx).toBeLessThan(messageIdx)
    })

    it("should call provider.sendAudio for valid audio messages", async () => {
      await connectAndGetMessageHandler()

      const audioData = Buffer.from("AQID", "base64") // 3 bytes
      messageHandler(Buffer.from(JSON.stringify({ type: "audio", data: "AQID" })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.sendAudio).toHaveBeenCalledWith(audioData)
    })

    it("should reject oversized audio messages", async () => {
      await connectAndGetMessageHandler()

      // Create a base64 string larger than MAX_AUDIO_DATA_LENGTH (mocked to 131072)
      const oversizedData = "A".repeat(200_000)
      messageHandler(Buffer.from(JSON.stringify({ type: "audio", data: oversizedData })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.sendAudio).not.toHaveBeenCalled()
    })

    it("should rate-limit audio messages", async () => {
      await connectAndGetMessageHandler()

      // Send two audio messages with no delay — second should be dropped
      const msg = Buffer.from(JSON.stringify({ type: "audio", data: "AQID" }))
      messageHandler(msg)
      messageHandler(msg) // immediate — within MIN_AUDIO_INTERVAL_MS

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      // Only the first call should go through
      expect(mockProvider.sendAudio).toHaveBeenCalledTimes(1)
    })

    it("should call provider.disconnect for disconnect messages", async () => {
      await connectAndGetMessageHandler()

      messageHandler(Buffer.from(JSON.stringify({ type: "disconnect" })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.disconnect).toHaveBeenCalled()
    })

    it("should ignore messages with invalid format", async () => {
      await connectAndGetMessageHandler()

      messageHandler(Buffer.from(JSON.stringify({ foo: "bar" })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.sendAudio).not.toHaveBeenCalled()
      expect(mockProvider.disconnect).not.toHaveBeenCalled()
    })
  })

  describe("chunked cookie edge cases", () => {
    it("should handle cookies with = in value", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      // Session tokens often contain = padding
      const req = createMockReq({
        "authjs.session-token": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIn0..abc==",
      })

      await handleVoiceConnection(ws, req)

      expect(mockDecode).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2Q0JDLUhTNTEyIn0..abc==",
        })
      )
    })

    it("should stop chunk assembly at first missing index", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockHasToolAccess.mockResolvedValue(true)

      const ws = createMockWs()
      // Gap at index 1 — should only get chunk 0
      const req = createMockReq({
        "authjs.session-token.0": "chunk0",
        "authjs.session-token.2": "chunk2",
      })

      await handleVoiceConnection(ws, req)

      expect(mockDecode).toHaveBeenCalledWith(
        expect.objectContaining({ token: "chunk0" })
      )
    })
  })
})
