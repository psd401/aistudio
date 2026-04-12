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
    delete process.env.VOICE_ENABLED
  })

  it("should return null provider/model and enabled=false when no settings are configured", async () => {
    const result = await Settings.getVoice()

    expect(result).toEqual({
      provider: null,
      model: null,
      language: "en-US",
      voiceName: null,
      enabled: false,
    })
  })

  it("should return DB values when configured", async () => {
    mockGetSettingValue.mockImplementation((key: string) => {
      const values: Record<string, string> = {
        VOICE_PROVIDER: "openai-realtime",
        VOICE_MODEL: "gpt-4o-realtime",
        VOICE_LANGUAGE: "fr-FR",
        VOICE_NAME: "alloy",
        VOICE_ENABLED: "true",
      }
      return Promise.resolve(values[key] || null)
    })

    const result = await Settings.getVoice()

    expect(result).toEqual({
      provider: "openai-realtime",
      model: "gpt-4o-realtime",
      language: "fr-FR",
      voiceName: "alloy",
      enabled: true,
    })
  })

  it("should fall back to env vars when DB returns null", async () => {
    process.env.VOICE_PROVIDER = "env-provider"
    process.env.VOICE_MODEL = "env-model"

    const result = await Settings.getVoice()

    expect(result.provider).toBe("env-provider")
    expect(result.model).toBe("env-model")
    // Default for language since no env var set
    expect(result.language).toBe("en-US")
  })

  it("should query the correct setting keys", async () => {
    await Settings.getVoice()

    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_PROVIDER")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_MODEL")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_LANGUAGE")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_NAME")
    expect(mockGetSettingValue).toHaveBeenCalledWith("VOICE_ENABLED")
  })

  it("should handle partial DB configuration — null for unconfigured fields", async () => {
    mockGetSettingValue.mockImplementation((key: string) => {
      if (key === "VOICE_MODEL") return Promise.resolve("custom-model")
      return Promise.resolve(null)
    })

    const result = await Settings.getVoice()

    expect(result.provider).toBeNull() // null when not configured
    expect(result.model).toBe("custom-model") // from DB
    expect(result.language).toBe("en-US") // default
    expect(result.voiceName).toBeNull() // null when not set
    expect(result.enabled).toBe(false) // default to false
  })

  it("should return enabled=true only when VOICE_ENABLED is exactly 'true'", async () => {
    // 'false' string → false
    mockGetSettingValue.mockImplementation((key: string) => {
      if (key === "VOICE_ENABLED") return Promise.resolve("false")
      return Promise.resolve(null)
    })
    let result = await Settings.getVoice()
    expect(result.enabled).toBe(false)

    // Clear cache so next call re-fetches
    await revalidateSettingsCache()

    // 'true' string → true
    mockGetSettingValue.mockImplementation((key: string) => {
      if (key === "VOICE_ENABLED") return Promise.resolve("true")
      return Promise.resolve(null)
    })
    result = await Settings.getVoice()
    expect(result.enabled).toBe(true)

    await revalidateSettingsCache()

    // Any other value → false
    mockGetSettingValue.mockImplementation((key: string) => {
      if (key === "VOICE_ENABLED") return Promise.resolve("yes")
      return Promise.resolve(null)
    })
    result = await Settings.getVoice()
    expect(result.enabled).toBe(false)
  })
})
