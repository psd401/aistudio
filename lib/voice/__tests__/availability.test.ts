/**
 * Tests for voice availability utility (lib/voice/availability.ts).
 *
 * Covers all 4 failure paths and the success path of getVoiceAvailability():
 * 1. VOICE_ENABLED=false → disabled reason (type: permission)
 * 2. No tool access → role reason (type: permission)
 * 3. Missing/unsupported provider → config reason (type: config)
 * 4. Missing API key → config reason (type: config)
 * 5. All checks pass → available: true
 *
 * Issue #876
 */

// Mock settings
const mockGetVoice = jest.fn()
const mockGetGoogleAI = jest.fn()
jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getVoice: (...args: unknown[]) => mockGetVoice(...args),
    getGoogleAI: (...args: unknown[]) => mockGetGoogleAI(...args),
  },
}))

// Mock hasToolAccess
const mockHasToolAccess = jest.fn()
jest.mock("@/lib/db/drizzle/users", () => ({
  hasToolAccess: (...args: unknown[]) => mockHasToolAccess(...args),
}))

// Mock provider factory
const mockIsSupportedVoiceProvider = jest.fn()
jest.mock("../provider-factory", () => ({
  isSupportedVoiceProvider: (...args: unknown[]) => mockIsSupportedVoiceProvider(...args),
}))

import { getVoiceAvailability } from "../availability"

describe("getVoiceAvailability", () => {
  const TEST_SUB = "user-cognito-sub-123"

  beforeEach(() => {
    jest.clearAllMocks()
    // Default: all checks pass
    mockGetVoice.mockResolvedValue({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      enabled: true,
    })
    mockHasToolAccess.mockResolvedValue(true)
    mockIsSupportedVoiceProvider.mockReturnValue(true)
    mockGetGoogleAI.mockResolvedValue("test-google-api-key")
  })

  it("should return available: true with validated config when all checks pass", async () => {
    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(true)
    expect(result.config).toEqual({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      apiKey: "test-google-api-key",
    })
    expect(mockGetVoice).toHaveBeenCalled()
    expect(mockHasToolAccess).toHaveBeenCalledWith(TEST_SUB, "voice-mode")
    expect(mockIsSupportedVoiceProvider).toHaveBeenCalledWith("gemini-live")
    expect(mockGetGoogleAI).toHaveBeenCalled()
  })

  it("should return disabled reason when VOICE_ENABLED is false", async () => {
    mockGetVoice.mockResolvedValue({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      enabled: false,
    })

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is disabled by administrator")
    expect(result.type).toBe("permission")
    // Should short-circuit — no tool access or config checks
    expect(mockHasToolAccess).not.toHaveBeenCalled()
    expect(mockGetGoogleAI).not.toHaveBeenCalled()
  })

  it("should return role reason when user lacks voice-mode access", async () => {
    mockHasToolAccess.mockResolvedValue(false)

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not enabled for your role")
    expect(result.type).toBe("permission")
    // Should short-circuit — no config checks
    expect(mockGetGoogleAI).not.toHaveBeenCalled()
  })

  it("should return config reason when provider is missing", async () => {
    mockGetVoice.mockResolvedValue({
      provider: null,
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      enabled: true,
    })

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not currently available")
    expect(result.internalReason).toBe("Voice provider not configured or unsupported")
    expect(result.type).toBe("config")
    // Should short-circuit — no API key check
    expect(mockGetGoogleAI).not.toHaveBeenCalled()
  })

  it("should return config reason when model is missing", async () => {
    mockGetVoice.mockResolvedValue({
      provider: "gemini-live",
      model: null,
      language: "en-US",
      voiceName: null,
      enabled: true,
    })

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not currently available")
    expect(result.type).toBe("config")
  })

  it("should return config reason when provider is unsupported", async () => {
    mockIsSupportedVoiceProvider.mockReturnValue(false)
    mockGetVoice.mockResolvedValue({
      provider: "unsupported-provider",
      model: "some-model",
      language: "en-US",
      voiceName: null,
      enabled: true,
    })

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not currently available")
    expect(result.internalReason).toBe("Voice provider not configured or unsupported")
    expect(result.type).toBe("config")
    expect(mockIsSupportedVoiceProvider).toHaveBeenCalledWith("unsupported-provider")
  })

  it("should return config reason when Google API key is missing", async () => {
    mockGetGoogleAI.mockResolvedValue(null)

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not currently available")
    expect(result.internalReason).toBe("Voice provider API key not configured")
    expect(result.type).toBe("config")
  })

  it("should return config with provider, model, language, voiceName, and apiKey when available", async () => {
    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(true)
    expect(result.config).toEqual({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      apiKey: "test-google-api-key",
    })
  })

  it("should not include config when unavailable", async () => {
    mockGetVoice.mockResolvedValue({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      enabled: false,
    })

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.config).toBeUndefined()
  })

  it("should propagate errors when Settings.getVoice() throws", async () => {
    mockGetVoice.mockRejectedValue(new Error("DB connection timeout"))

    await expect(getVoiceAvailability(TEST_SUB)).rejects.toThrow("DB connection timeout")
  })

  it("should propagate errors when hasToolAccess() throws", async () => {
    mockHasToolAccess.mockRejectedValue(new Error("Database unavailable"))

    await expect(getVoiceAvailability(TEST_SUB)).rejects.toThrow("Database unavailable")
  })

  it("should propagate errors when Settings.getGoogleAI() throws", async () => {
    mockGetGoogleAI.mockRejectedValue(new Error("Secrets Manager error"))

    await expect(getVoiceAvailability(TEST_SUB)).rejects.toThrow("Secrets Manager error")
  })

  it("should check conditions in order and short-circuit", async () => {
    // Disabled at step 1 — nothing else should be called
    mockGetVoice.mockResolvedValue({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
      enabled: false,
    })

    await getVoiceAvailability(TEST_SUB)

    expect(mockGetVoice).toHaveBeenCalledTimes(1)
    expect(mockHasToolAccess).not.toHaveBeenCalled()
    expect(mockIsSupportedVoiceProvider).not.toHaveBeenCalled()
    expect(mockGetGoogleAI).not.toHaveBeenCalled()
  })
})
