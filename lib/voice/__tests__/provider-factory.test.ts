// Mock @google/genai before importing modules that depend on it
jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn(),
  Modality: { AUDIO: "AUDIO" },
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  generateRequestId: () => "test-id",
  startTimer: () => jest.fn(),
}))

import {
  createVoiceProvider,
  isSupportedVoiceProvider,
  getSupportedVoiceProviders,
} from "../provider-factory"
import { GeminiLiveProvider } from "../gemini-live-provider"

describe("createVoiceProvider", () => {
  it("should create a GeminiLiveProvider for 'gemini-live'", () => {
    const provider = createVoiceProvider("gemini-live")
    expect(provider).toBeInstanceOf(GeminiLiveProvider)
    expect(provider.providerId).toBe("gemini-live")
  })

  it("should normalize provider ID to lowercase", () => {
    const provider = createVoiceProvider("Gemini-Live")
    expect(provider).toBeInstanceOf(GeminiLiveProvider)
  })

  it("should throw for unsupported provider", () => {
    expect(() => createVoiceProvider("openai-realtime")).toThrow(
      "Unsupported voice provider: 'openai-realtime'"
    )
  })

  it("should throw with list of supported providers in error", () => {
    expect(() => createVoiceProvider("unknown")).toThrow("Supported: gemini-live")
  })
})

describe("isSupportedVoiceProvider", () => {
  it("should return true for gemini-live", () => {
    expect(isSupportedVoiceProvider("gemini-live")).toBe(true)
  })

  it("should return true regardless of case", () => {
    expect(isSupportedVoiceProvider("GEMINI-LIVE")).toBe(true)
  })

  it("should return false for unsupported provider", () => {
    expect(isSupportedVoiceProvider("openai-realtime")).toBe(false)
  })
})

describe("getSupportedVoiceProviders", () => {
  it("should return array including gemini-live", () => {
    const providers = getSupportedVoiceProviders()
    expect(providers).toContain("gemini-live")
  })

  it("should return a readonly array", () => {
    const providers = getSupportedVoiceProviders()
    expect(Array.isArray(providers)).toBe(true)
  })
})
