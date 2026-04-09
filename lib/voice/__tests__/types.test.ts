/**
 * Tests for voice provider types and protocol messages.
 * Validates the interface contract is satisfied and message format is correct.
 */

import type {
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSessionState,
  TranscriptEntry,
  VoiceClientMessage,
  VoiceServerMessage,
} from "../types"

describe("VoiceProvider interface contract", () => {
  it("should define the expected provider interface shape", () => {
    // Type-level test: ensure the interface has the expected methods
    const mockProvider: VoiceProvider = {
      providerId: "test",
      connect: jest.fn(),
      disconnect: jest.fn(),
      sendAudio: jest.fn(),
      getSessionState: jest.fn(),
      isConnected: jest.fn(),
    }

    expect(mockProvider.providerId).toBe("test")
    expect(typeof mockProvider.connect).toBe("function")
    expect(typeof mockProvider.disconnect).toBe("function")
    expect(typeof mockProvider.sendAudio).toBe("function")
    expect(typeof mockProvider.getSessionState).toBe("function")
    expect(typeof mockProvider.isConnected).toBe("function")
  })
})

describe("VoiceProviderConfig", () => {
  it("should accept minimal config", () => {
    const config: VoiceProviderConfig = {
      model: "test-model",
    }
    expect(config.model).toBe("test-model")
    expect(config.language).toBeUndefined()
    expect(config.voiceName).toBeUndefined()
    expect(config.systemInstruction).toBeUndefined()
    expect(config.apiKey).toBeUndefined()
  })

  it("should accept full config", () => {
    const config: VoiceProviderConfig = {
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: "Aoede",
      systemInstruction: "Be helpful",
      apiKey: "test-key",
    }
    expect(config.language).toBe("en-US")
    expect(config.voiceName).toBe("Aoede")
  })
})

describe("VoiceSessionState", () => {
  it("should represent a disconnected session", () => {
    const state: VoiceSessionState = {
      connected: false,
      speaking: "none",
      transcript: [],
    }
    expect(state.connected).toBe(false)
    expect(state.speaking).toBe("none")
  })

  it("should represent an active session with transcripts", () => {
    const entry: TranscriptEntry = {
      role: "user",
      text: "Hello",
      timestamp: new Date(),
      isFinal: true,
    }
    const state: VoiceSessionState = {
      connected: true,
      speaking: "assistant",
      transcript: [entry],
    }
    expect(state.connected).toBe(true)
    expect(state.speaking).toBe("assistant")
    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0].role).toBe("user")
  })
})

describe("WebSocket protocol messages", () => {
  describe("VoiceClientMessage", () => {
    it("should represent an audio message", () => {
      const msg: VoiceClientMessage = {
        type: "audio",
        data: "base64encodedaudio==",
      }
      expect(msg.type).toBe("audio")
    })


    it("should represent a disconnect message", () => {
      const msg: VoiceClientMessage = {
        type: "disconnect",
      }
      expect(msg.type).toBe("disconnect")
    })
  })

  describe("VoiceServerMessage", () => {
    it("should represent an audio response", () => {
      const msg: VoiceServerMessage = {
        type: "audio",
        data: "base64audio==",
      }
      expect(msg.type).toBe("audio")
    })

    it("should represent a transcript", () => {
      const msg: VoiceServerMessage = {
        type: "transcript",
        entry: {
          role: "assistant",
          text: "Hello!",
          isFinal: true,
          timestamp: new Date().toISOString(),
        },
      }
      expect(msg.type).toBe("transcript")
      expect(msg.entry.role).toBe("assistant")
    })

    it("should represent a state change", () => {
      const msg: VoiceServerMessage = {
        type: "state",
        speaking: "assistant",
      }
      expect(msg.type).toBe("state")
    })

    it("should represent a ready signal", () => {
      const msg: VoiceServerMessage = {
        type: "ready",
      }
      expect(msg.type).toBe("ready")
    })

    it("should represent an error", () => {
      const msg: VoiceServerMessage = {
        type: "error",
        message: "Connection failed",
      }
      expect(msg.type).toBe("error")
    })

    it("should represent session end", () => {
      const msg: VoiceServerMessage = {
        type: "session_ended",
        reason: "finished",
      }
      expect(msg.type).toBe("session_ended")
    })
  })
})
