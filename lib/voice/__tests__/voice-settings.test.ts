/**
 * Tests for Settings.getVoice() in settings-manager.ts
 */

// Mock the Drizzle setting getter
const mockGetSettingValue = jest.fn()

jest.mock("@/lib/db/drizzle", () => ({
  getSettingValue: (...args: unknown[]) => mockGetSettingValue(...args),
}))

jest.mock("@/lib/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

// Mock S3 client (needed by revalidateSettingsCache)
jest.mock("@/lib/aws/s3-client", () => ({
  clearS3Cache: jest.fn(),
}))

// Import after mocks
import { Settings, revalidateSettingsCache } from "@/lib/settings-manager"

describe("Settings.getVoice", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    mockGetSettingValue.mockResolvedValue(null)
    // Clear settings cache to ensure DB mock is called
    await revalidateSettingsCache()
    // Clear env vars
    delete process.env.VOICE_PROVIDER
    delete process.env.VOICE_MODEL
    delete process.env.VOICE_LANGUAGE
    delete process.env.VOICE_NAME
  })

  it("should return defaults when no settings are configured", async () => {
    const result = await Settings.getVoice()

    expect(result).toEqual({
      provider: "gemini-live",
      model: "gemini-2.0-flash-live-001",
      language: "en-US",
      voiceName: null,
    })
  })

  it("should return DB values when configured", async () => {
    mockGetSettingValue.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        VOICE_PROVIDER: "openai-realtime",
        VOICE_MODEL: "gpt-4o-realtime",
        VOICE_LANGUAGE: "fr-FR",
        VOICE_NAME: "alloy",
      }
      return Promise.resolve(values[key] || null)
    })

    const result = await Settings.getVoice()

    expect(result).toEqual({
      provider: "openai-realtime",
      model: "gpt-4o-realtime",
      language: "fr-FR",
      voiceName: "alloy",
    })
  })

  it("should fall back to env vars when DB returns null", async () => {
    process.env.VOICE_PROVIDER = "env-provider"
    process.env.VOICE_MODEL = "env-model"

    const result = await Settings.getVoice()

    expect(result.provider).toBe("env-provider")
    expect(result.model).toBe("env-model")
    // Defaults for language since no env var set
    expect(result.language).toBe("en-US")
  })

  it("should query the correct setting keys", async () => {
    await Settings.getVoice()

    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_PROVIDER")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_MODEL")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_LANGUAGE")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_NAME")
  })

  it("should handle partial DB configuration with defaults", async () => {
    mockGetSettingValue.mockImplementation((key: string) => {
      if (key === "VOICE_MODEL") return Promise.resolve("custom-model")
      return Promise.resolve(null)
    })

    const result = await Settings.getVoice()

    expect(result.provider).toBe("gemini-live") // default
    expect(result.model).toBe("custom-model") // from DB
    expect(result.language).toBe("en-US") // default
    expect(result.voiceName).toBeNull() // null when not set
  })
})
