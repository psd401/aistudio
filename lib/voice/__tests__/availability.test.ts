/**
 * Tests for voice availability utility (lib/voice/availability.ts).
 *
 * Covers all 4 failure paths and the success path of getVoiceAvailability():
 * 1. VOICE_ENABLED=false → disabled reason (type: permission)
 * 2. No tool access → role reason (type: permission)
 * 3. Missing/unsupported provider → config reason (type: config)
 * 4. Gemini credentials not configured → config reason (type: config)
 * 5. All checks pass → available: true
 *
 * Issue #876
 */

// Mock settings
const mockGetVoice = jest.fn()
jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getVoice: (...args: unknown[]) => mockGetVoice(...args),
  },
}))

// Mock Gemini credential probe (Vertex WIF or local-dev API key)
const mockIsGoogleConfigured = jest.fn()
jest.mock("@/lib/ai/google-provider", () => ({
  isGoogleConfigured: (...args: unknown[]) => mockIsGoogleConfigured(...args),
}))

// Mock hasCapabilityAccess
const mockHasCapabilityAccess = jest.fn()
jest.mock("@/lib/db/drizzle/capabilities", () => ({
  hasCapabilityAccess: (...args: unknown[]) => mockHasCapabilityAccess(...args),
}))

// Mock provider factory
const mockIsSupportedVoiceProvider = jest.fn()
jest.mock("../provider-factory", () => ({
  isSupportedVoiceProvider: (...args: unknown[]) => mockIsSupportedVoiceProvider(...args),
}))

import { getVoiceAvailability } from "../availability"

const TEST_SUB = "user-cognito-sub-123"

function defineGetVoiceAvailabilitySuite1Part1() {


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
    mockHasCapabilityAccess.mockResolvedValue(true)
    mockIsSupportedVoiceProvider.mockReturnValue(true)
    mockIsGoogleConfigured.mockResolvedValue(true)
  })

  it("should return available: true with validated config when all checks pass", async () => {
    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(true)
    expect(result.config).toEqual({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
    })
    expect(mockGetVoice).toHaveBeenCalled()
    expect(mockHasCapabilityAccess).toHaveBeenCalledWith(TEST_SUB, "voice-mode")
    expect(mockIsSupportedVoiceProvider).toHaveBeenCalledWith("gemini-live")
    expect(mockIsGoogleConfigured).toHaveBeenCalled()
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
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled()
    expect(mockIsGoogleConfigured).not.toHaveBeenCalled()
  })

  it("should return role reason when user lacks voice-mode access", async () => {
    mockHasCapabilityAccess.mockResolvedValue(false)

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not enabled for your role")
    expect(result.type).toBe("permission")
    // Should short-circuit — no config checks
    expect(mockIsGoogleConfigured).not.toHaveBeenCalled()
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
    // Should short-circuit — no credential check
    expect(mockIsGoogleConfigured).not.toHaveBeenCalled()
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

  }

function defineGetVoiceAvailabilitySuite1Part2() {it("should return config reason when provider is unsupported", async () => {
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

  it("should return config reason when Gemini credentials are not configured", async () => {
    mockIsGoogleConfigured.mockResolvedValue(false)

    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(false)
    expect(result.reason).toBe("Voice mode is not currently available")
    expect(result.internalReason).toBe("Voice provider credentials not configured")
    expect(result.type).toBe("config")
  })

  it("should return config with provider, model, language, and voiceName (no credentials) when available", async () => {
    const result = await getVoiceAvailability(TEST_SUB)

    expect(result.available).toBe(true)
    expect(result.config).toEqual({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
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

  it("should propagate errors when hasCapabilityAccess() throws", async () => {
    mockHasCapabilityAccess.mockRejectedValue(new Error("Database unavailable"))

    await expect(getVoiceAvailability(TEST_SUB)).rejects.toThrow("Database unavailable")
  })

  it("should propagate errors when the Gemini credential probe throws", async () => {
    mockIsGoogleConfigured.mockRejectedValue(new Error("Vertex AI auth is partly configured"))

    await expect(getVoiceAvailability(TEST_SUB)).rejects.toThrow("Vertex AI auth is partly configured")
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
    expect(mockHasCapabilityAccess).not.toHaveBeenCalled()
    expect(mockIsSupportedVoiceProvider).not.toHaveBeenCalled()
    expect(mockIsGoogleConfigured).not.toHaveBeenCalled()
  })
}

const defineGetVoiceAvailabilitySuite1 = () => {
  defineGetVoiceAvailabilitySuite1Part1()
  defineGetVoiceAvailabilitySuite1Part2()
};

describe("getVoiceAvailability", defineGetVoiceAvailabilitySuite1)
