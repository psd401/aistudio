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
  PROVIDER_CONNECT_TIMEOUT_MS: 200,
  MIN_AUDIO_INTERVAL_MS: 20,
  PING_INTERVAL_MS: 240_000,
  WS_OPEN: 1,
  MAX_CONVERSATION_ID_LENGTH: 36,
  MAX_VOICE_CONTEXT_MESSAGES: 20,
  MAX_SESSION_INSTRUCTION_LENGTH: 10_000,
}))

// Mock voice instruction builder (server-side instruction building from DB)
const mockBuildInstructionFromConversation = jest.fn()
jest.mock("../voice-instruction-builder", () => ({
  buildInstructionFromConversation: (...args: unknown[]) => mockBuildInstructionFromConversation(...args),
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

// Mock voice availability (centralized check — Issue #876)
// Note: Settings is no longer imported by ws-handler (config comes from
// getVoiceAvailability().config), so no Settings mock is needed here.
const mockGetVoiceAvailability = jest.fn()
jest.mock("../availability", () => ({
  getVoiceAvailability: (...args: unknown[]) => mockGetVoiceAvailability(...args),
}))

// Convenience helper — translates a boolean into the full availability mock shape.
// Named mockVoiceAccess (not mockHasToolAccess) to reflect it mocks getVoiceAvailability.
const mockVoiceAccess = {
  mockResolvedValue(val: boolean) {
    if (val) {
      mockGetVoiceAvailability.mockResolvedValue({
        available: true,
        config: {
          provider: "gemini-live",
          model: "gemini-2.0-flash-live-001",
          language: "en-US",
          voiceName: null,
          apiKey: "test-api-key",
        },
      })
    } else {
      mockGetVoiceAvailability.mockResolvedValue({ available: false, reason: "Voice mode is not enabled for your role" })
    }
  },
  mockRejectedValue(err: Error) {
    mockGetVoiceAvailability.mockRejectedValue(err)
  },
}

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

/**
 * Helper to create a mock WebSocket that properly tracks event listeners.
 * Supports the two-phase handshake: waitForSessionConfig registers and
 * removes "message" listeners, then the main handler registers another.
 */
type MockWs = Parameters<typeof handleVoiceConnection>[0] & {
  _emit: (event: string, ...args: unknown[]) => void
  _listeners: Map<string, Set<(...args: unknown[]) => void>>
}

function createMockWs(): MockWs {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  const ws: Record<string, unknown> = {
    readyState: 1, // OPEN
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return ws
    }),
    removeListener: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler)
      return ws
    }),
    ping: jest.fn(),
    removeAllListeners: jest.fn((event?: string) => {
      if (event) {
        listeners.delete(event)
      } else {
        listeners.clear()
      }
    }),
    _emit: (event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event)
      if (handlers) {
        for (const handler of handlers) handler(...args)
      }
    },
    _listeners: listeners,
  }
  return ws as unknown as MockWs
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

/**
 * Schedule a session_config message to be sent shortly after handleVoiceConnection
 * registers its listener. Needed because the two-phase handshake waits up to 5s
 * for session_config, causing tests that pass auth to hang without this.
 */
function scheduleSessionConfig(ws: MockWs, config?: { conversationId?: string }) {
  setTimeout(() => {
    ws._emit("message", Buffer.from(JSON.stringify({ type: "session_config", ...config })))
  }, 10)
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
      mockVoiceAccess.mockResolvedValue(true)

      const ws = createMockWs()
      scheduleSessionConfig(ws)
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
      mockVoiceAccess.mockResolvedValue(true)

      const ws = createMockWs()
      scheduleSessionConfig(ws)
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
      mockVoiceAccess.mockResolvedValue(true)

      const ws = createMockWs()
      scheduleSessionConfig(ws)
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
      mockGetVoiceAvailability.mockResolvedValue({ available: false, reason: "Voice mode is not enabled for your role", type: "permission" })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(mockGetVoiceAvailability).toHaveBeenCalledWith("user-123")
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Voice mode is not enabled for your role")
      )
      expect(ws.close).toHaveBeenCalledWith(4003, "Forbidden")
    })

    it("should close with 4003 when VOICE_ENABLED is false (admin kill switch)", async () => {
      mockGetVoiceAvailability.mockResolvedValue({ available: false, reason: "Voice mode is disabled by administrator", type: "permission" })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(mockGetVoiceAvailability).toHaveBeenCalledWith("user-123")
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Voice mode is disabled by administrator")
      )
      expect(ws.close).toHaveBeenCalledWith(4003, "Forbidden")
    })

    it("should close with 4500 when availability check throws (fail-closed)", async () => {
      mockGetVoiceAvailability.mockRejectedValue(new Error("DB error"))

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // Client receives generic message — not the internal "Availability check failed" string
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Voice mode is not currently available")
      )
      expect(ws.close).toHaveBeenCalledWith(4500, "Availability check failed")
    })

    it("should close with 4500 when availability returns true but config is missing (invariant violation)", async () => {
      // Simulate an impossible state: available=true but no config object
      mockGetVoiceAvailability.mockResolvedValue({ available: true })

      const ws = createMockWs()
      scheduleSessionConfig(ws)
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // The invariant throw propagates to the outer catch which sends "Failed to establish voice session"
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Failed to establish voice session")
      )
      expect(ws.close).toHaveBeenCalledWith(4500, "Internal error")
    })

    it("should proceed when user has voice-mode access", async () => {
      mockVoiceAccess.mockResolvedValue(true)

      const ws = createMockWs()
      scheduleSessionConfig(ws)
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

    it("should close with 4500 when Google API key is missing (caught by availability check)", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockGetVoiceAvailability.mockResolvedValue({
        available: false,
        reason: "Voice mode is not currently available",
        internalReason: "Voice provider API key not configured",
        type: "config",
      })

      const ws = createMockWs()
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // Client receives generic reason, not internal config details
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("Voice mode is not currently available")
      )
      // Config issues use 4500, not 4003
      expect(ws.close).toHaveBeenCalledWith(4500, "Provider not configured")
    })

    it("should close with 4500 when provider.connect() times out", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockVoiceAccess.mockResolvedValue(true)

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
      scheduleSessionConfig(ws)
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.close).toHaveBeenCalledWith(4500, "Internal error")
    }, 5_000)

    it("should remove listeners on connect failure", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockVoiceAccess.mockResolvedValue(true)

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
      scheduleSessionConfig(ws)
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      expect(ws.removeAllListeners).toHaveBeenCalledWith("message")
      expect(ws.removeAllListeners).toHaveBeenCalledWith("close")
      expect(ws.removeAllListeners).toHaveBeenCalledWith("error")
    })
  })

  describe("message handling", () => {
    beforeEach(() => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockVoiceAccess.mockResolvedValue(true)
    })

    /** Connect and return the ws mock. Messages can be sent via ws._emit("message", ...) */
    async function connectWs() {
      const ws = createMockWs()
      scheduleSessionConfig(ws)
      const req = createMockReq({ "authjs.session-token": "valid-token" })
      await handleVoiceConnection(ws, req)
      return ws
    }

    it("should register close/error handlers before message handler", async () => {
      const ws = createMockWs()
      scheduleSessionConfig(ws)
      const registrationOrder: string[] = []
      const origOn = ws.on as jest.Mock
      origOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        registrationOrder.push(event)
        // Still track listeners so handshake works
        if (!ws._listeners.has(event)) ws._listeners.set(event, new Set())
        ws._listeners.get(event)!.add(handler)
        return ws
      })

      await handleVoiceConnection(ws, createMockReq({ "authjs.session-token": "valid-token" }))

      const closeIdx = registrationOrder.indexOf("close")
      const errorIdx = registrationOrder.indexOf("error")
      // "message" appears twice: once for waitForSessionConfig, once for the main handler.
      // The main handler registration is the LAST "message" entry.
      const messageIdx = registrationOrder.lastIndexOf("message")
      expect(closeIdx).toBeLessThan(messageIdx)
      expect(errorIdx).toBeLessThan(messageIdx)
    })

    it("should call provider.sendAudio for valid audio messages", async () => {
      const ws = await connectWs()

      ws._emit("message", Buffer.from(JSON.stringify({ type: "audio", data: "AQID" })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      const audioData = Buffer.from("AQID", "base64")
      expect(mockProvider.sendAudio).toHaveBeenCalledWith(audioData)
    })

    it("should reject oversized audio messages", async () => {
      const ws = await connectWs()

      const oversizedData = "A".repeat(200_000)
      ws._emit("message", Buffer.from(JSON.stringify({ type: "audio", data: oversizedData })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.sendAudio).not.toHaveBeenCalled()
    })

    it("should rate-limit audio messages", async () => {
      const ws = await connectWs()

      const msg = Buffer.from(JSON.stringify({ type: "audio", data: "AQID" }))
      ws._emit("message", msg)
      ws._emit("message", msg) // immediate — within MIN_AUDIO_INTERVAL_MS

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.sendAudio).toHaveBeenCalledTimes(1)
    })

    it("should call provider.disconnect for disconnect messages", async () => {
      const ws = await connectWs()

      ws._emit("message", Buffer.from(JSON.stringify({ type: "disconnect" })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.disconnect).toHaveBeenCalled()
    })

    it("should ignore messages with invalid format", async () => {
      const ws = await connectWs()

      ws._emit("message", Buffer.from(JSON.stringify({ foo: "bar" })))

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider()
      expect(mockProvider.sendAudio).not.toHaveBeenCalled()
      expect(mockProvider.disconnect).not.toHaveBeenCalled()
    })
  })

  describe("session_config handling", () => {
    beforeEach(() => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockVoiceAccess.mockResolvedValue(true)
    })

    it("should build systemInstruction server-side from conversationId", async () => {
      const testConversationId = "550e8400-e29b-41d4-a716-446655440000"
      const serverBuiltInstruction = "You are a helpful AI assistant. Prior conversation:\nUser: Hello"
      mockBuildInstructionFromConversation.mockResolvedValue(serverBuiltInstruction)

      const ws = createMockWs()
      scheduleSessionConfig(ws, { conversationId: testConversationId })
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // Verify server-side instruction builder was called with conversationId and user sub
      expect(mockBuildInstructionFromConversation).toHaveBeenCalledWith(
        testConversationId,
        "user-123",
      )

      // Verify the server-built instruction was passed to the provider
      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider.mock.results[0]?.value
      expect(mockProvider.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: serverBuiltInstruction,
        }),
        expect.any(Function),
        expect.anything(),
      )
    })

    it("should pass undefined systemInstruction when no conversationId provided", async () => {
      const ws = createMockWs()
      scheduleSessionConfig(ws)
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // Should NOT call the instruction builder
      expect(mockBuildInstructionFromConversation).not.toHaveBeenCalled()

      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider.mock.results[0]?.value
      expect(mockProvider.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: undefined,
        }),
        expect.any(Function),
        expect.anything(),
      )
    })

    it("should proceed without instruction when builder fails", async () => {
      mockBuildInstructionFromConversation.mockRejectedValue(new Error("DB connection error"))

      const ws = createMockWs()
      scheduleSessionConfig(ws, { conversationId: "550e8400-e29b-41d4-a716-446655440000" })
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      await handleVoiceConnection(ws, req)

      // Should still connect, just without systemInstruction
      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider.mock.results[0]?.value
      expect(mockProvider.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: undefined,
        }),
        expect.any(Function),
        expect.anything(),
      )
    })
  })

  describe("session_config timeout", () => {
    beforeEach(() => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockVoiceAccess.mockResolvedValue(true)
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it("should proceed with default config when client sends nothing within timeout", async () => {
      const ws = createMockWs()
      // Do NOT call scheduleSessionConfig — simulate client sending nothing
      const req = createMockReq({ "authjs.session-token": "valid-token" })

      const connectionPromise = handleVoiceConnection(ws, req)

      // Flush microtasks so the handler reaches waitForSessionConfig, then advance
      // past the 5-second SESSION_CONFIG_TIMEOUT_MS and the 200ms provider connect timeout
      await jest.advanceTimersByTimeAsync(6_000)

      await connectionPromise

      // Should NOT call instruction builder (no conversationId)
      expect(mockBuildInstructionFromConversation).not.toHaveBeenCalled()

      // Should still connect to provider with no systemInstruction
      const { createVoiceProvider } = require("../provider-factory")
      const mockProvider = createVoiceProvider.mock.results[0]?.value
      expect(mockProvider.connect).toHaveBeenCalledWith(
        expect.objectContaining({ systemInstruction: undefined }),
        expect.any(Function),
        expect.anything(),
      )
    })
  })

  describe("chunked cookie edge cases", () => {
    it("should handle cookies with = in value", async () => {
      mockDecode.mockResolvedValue({ sub: "user-123" })
      mockVoiceAccess.mockResolvedValue(true)

      const ws = createMockWs()
      scheduleSessionConfig(ws)
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
      mockVoiceAccess.mockResolvedValue(true)

      const ws = createMockWs()
      scheduleSessionConfig(ws)
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
