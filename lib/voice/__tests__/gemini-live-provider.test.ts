import { GeminiLiveProvider } from "../gemini-live-provider"
import type { VoiceProviderConfig, VoiceProviderEvent } from "../types"

// Shared mock references so we can inspect calls from inside the provider
const mockSendRealtimeInput = jest.fn()
const mockClose = jest.fn()
const mockLiveConnect = jest.fn()

const mockSession = {
  sendRealtimeInput: mockSendRealtimeInput,
  close: mockClose,
  conn: { close: mockClose },
}

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    live: {
      connect: mockLiveConnect.mockImplementation(async (params: Record<string, unknown>) => {
        // Simulate successful connection — call onopen
        const callbacks = params.callbacks as Record<string, () => void> | undefined
        if (callbacks?.onopen) {
          setTimeout(() => callbacks.onopen(), 0)
        }
        return mockSession
      }),
    },
  })),
  Modality: { AUDIO: "AUDIO" },
}))

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

describe("GeminiLiveProvider", () => {
  let provider: GeminiLiveProvider

  beforeEach(() => {
    provider = new GeminiLiveProvider()
    jest.clearAllMocks()
    // Re-setup the connect mock after clearAllMocks
    mockLiveConnect.mockImplementation(async (params: Record<string, unknown>) => {
      const callbacks = params.callbacks as Record<string, () => void> | undefined
      if (callbacks?.onopen) {
        setTimeout(() => callbacks.onopen(), 0)
      }
      return mockSession
    })
  })

  const baseConfig: VoiceProviderConfig = {
    model: "gemini-2.0-flash-live-001",
    apiKey: "test-api-key",
    language: "en-US",
  }

  describe("providerId", () => {
    it('should be "gemini-live"', () => {
      expect(provider.providerId).toBe("gemini-live")
    })
  })

  describe("initial state", () => {
    it("should not be connected initially", () => {
      expect(provider.isConnected()).toBe(false)
    })

    it("should have default session state", () => {
      const state = provider.getSessionState()
      expect(state.connected).toBe(false)
      expect(state.speaking).toBe("none")
      expect(state.transcript).toEqual([])
    })
  })

  describe("connect", () => {
    it("should throw if no API key provided", async () => {
      const noKeyConfig = { ...baseConfig, apiKey: undefined }
      await expect(provider.connect(noKeyConfig, jest.fn())).rejects.toThrow(
        "Google API key is required"
      )
    })

    it("should throw if already connected", async () => {
      await provider.connect(baseConfig, jest.fn())
      await expect(provider.connect(baseConfig, jest.fn())).rejects.toThrow(
        "Session already connected"
      )
    })

    it("should connect using GoogleGenAI SDK", async () => {
      const { GoogleGenAI } = require("@google/genai")
      await provider.connect(baseConfig, jest.fn())

      expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: "test-api-key" })
    })

    it("should pass model to SDK connect", async () => {
      await provider.connect(baseConfig, jest.fn())

      expect(mockLiveConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-2.0-flash-live-001",
        })
      )
    })

    it("should configure audio transcription", async () => {
      await provider.connect(baseConfig, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.inputAudioTranscription).toEqual({})
      expect(connectArgs.config.outputAudioTranscription).toEqual({})
    })

    it("should configure response modalities as AUDIO", async () => {
      await provider.connect(baseConfig, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.responseModalities).toEqual(["AUDIO"])
    })

    it("should configure voice name when provided", async () => {
      const configWithVoice = { ...baseConfig, voiceName: "Aoede" }
      await provider.connect(configWithVoice, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.speechConfig).toEqual(
        expect.objectContaining({
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Aoede" },
          },
        })
      )
    })

    it("should configure system instruction when provided", async () => {
      const configWithInstruction = {
        ...baseConfig,
        systemInstruction: "You are a helpful assistant",
      }
      await provider.connect(configWithInstruction, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.systemInstruction).toBe("You are a helpful assistant")
    })

    it("should enable context window compression", async () => {
      await provider.connect(baseConfig, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.contextWindowCompression).toEqual({
        slidingWindow: { targetTokens: "10000" },
      })
    })

    it("should enable session resumption", async () => {
      await provider.connect(baseConfig, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.sessionResumption).toEqual({})
    })
  })

  describe("sendAudio", () => {
    it("should not throw when not connected", () => {
      expect(() => provider.sendAudio(Buffer.from("test"))).not.toThrow()
    })

    it("should send base64-encoded audio to SDK session", async () => {
      await provider.connect(baseConfig, jest.fn())

      const audioData = Buffer.from([0x01, 0x02, 0x03])
      provider.sendAudio(audioData)

      expect(mockSendRealtimeInput).toHaveBeenCalledWith({
        audio: {
          data: audioData.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      })
    })
  })

  describe("disconnect", () => {
    it("should be safe to call when not connected", async () => {
      await expect(provider.disconnect()).resolves.not.toThrow()
    })

    it("should close the session connection", async () => {
      await provider.connect(baseConfig, jest.fn())
      await provider.disconnect()

      expect(mockClose).toHaveBeenCalled()
    })

    it("should update state to disconnected", async () => {
      await provider.connect(baseConfig, jest.fn())
      await provider.disconnect()

      expect(provider.isConnected()).toBe(false)
      expect(provider.getSessionState().connected).toBe(false)
    })

    it("should emit session_ended event", async () => {
      const events: VoiceProviderEvent[] = []
      await provider.connect(baseConfig, (e) => events.push(e))
      await provider.disconnect()

      const endEvent = events.find((e) => e.type === "session_ended")
      expect(endEvent).toBeDefined()
      if (endEvent?.type === "session_ended") {
        expect(endEvent.reason).toBe("cancelled")
      }
    })
  })

  describe("getSessionState", () => {
    it("should return a copy of the state", () => {
      const state1 = provider.getSessionState()
      const state2 = provider.getSessionState()
      expect(state1).toEqual(state2)
      expect(state1).not.toBe(state2)
      expect(state1.transcript).not.toBe(state2.transcript)
    })
  })

  describe("sendAudio size validation", () => {
    it("should reject buffers larger than MAX_AUDIO_BUFFER_SIZE", async () => {
      await provider.connect(baseConfig, jest.fn())
      // 65KB > 64KB limit
      const oversizedBuffer = Buffer.alloc(65 * 1024)
      provider.sendAudio(oversizedBuffer)
      // Should NOT have called the SDK
      expect(mockSendRealtimeInput).not.toHaveBeenCalled()
    })

    it("should accept buffers within size limit", async () => {
      await provider.connect(baseConfig, jest.fn())
      const validBuffer = Buffer.alloc(32 * 1024)
      provider.sendAudio(validBuffer)
      expect(mockSendRealtimeInput).toHaveBeenCalled()
    })
  })

  describe("buildLiveConfig validation", () => {
    it("should truncate long voice names", async () => {
      const longNameConfig = {
        ...baseConfig,
        voiceName: "A".repeat(200),
      }
      await provider.connect(longNameConfig, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toHaveLength(100)
    })

    it("should truncate long system instructions", async () => {
      const longInstructionConfig = {
        ...baseConfig,
        systemInstruction: "X".repeat(20_000),
      }
      await provider.connect(longInstructionConfig, jest.fn())

      const connectArgs = mockLiveConnect.mock.calls[0][0]
      expect(connectArgs.config.systemInstruction).toHaveLength(10_000)
    })

    it("should accept valid BCP47 language codes", async () => {
      await provider.connect({ ...baseConfig, language: "en-US" }, jest.fn())
      const args = mockLiveConnect.mock.calls[0][0]
      expect(args.config.speechConfig?.languageCode).toBe("en-US")
    })

    it("should accept numeric subtags like es-419", async () => {
      await provider.connect({ ...baseConfig, language: "es-419" }, jest.fn())
      const args = mockLiveConnect.mock.calls[0][0]
      expect(args.config.speechConfig?.languageCode).toBe("es-419")
    })

    it("should reject invalid language codes", async () => {
      await provider.connect({ ...baseConfig, language: "not-a-language-code-at-all" }, jest.fn())
      const args = mockLiveConnect.mock.calls[0][0]
      // Invalid language should be skipped — no languageCode set
      expect(args.config.speechConfig?.languageCode).toBeUndefined()
    })

    it("should reject empty language code", async () => {
      await provider.connect({ ...baseConfig, language: "" }, jest.fn())
      const args = mockLiveConnect.mock.calls[0][0]
      expect(args.config.speechConfig?.languageCode).toBeUndefined()
    })
  })
})
