/** @jest-environment node */

const mockGetOpenAI = jest.fn()
const mockGetGoogleAI = jest.fn()
const mockGetAzureOpenAI = jest.fn()
const mockGetLatimer = jest.fn()

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getOpenAI: () => mockGetOpenAI(),
    getGoogleAI: () => mockGetGoogleAI(),
    getAzureOpenAI: () => mockGetAzureOpenAI(),
    getLatimer: () => mockGetLatimer(),
  },
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { getConfiguredChatProviders } from "../provider-credentials"

describe("getConfiguredChatProviders", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOpenAI.mockResolvedValue(null)
    mockGetGoogleAI.mockResolvedValue(null)
    mockGetAzureOpenAI.mockResolvedValue({ key: null, endpoint: null, resourceName: null })
    mockGetLatimer.mockResolvedValue(null)
  })

  it("always includes amazon-bedrock even with no keys configured", async () => {
    const configured = await getConfiguredChatProviders()
    expect(configured).toEqual(new Set(["amazon-bedrock"]))
  })

  it("includes every provider whose credential is present", async () => {
    mockGetOpenAI.mockResolvedValue("sk-test")
    mockGetGoogleAI.mockResolvedValue("google-key")
    mockGetAzureOpenAI.mockResolvedValue({ key: "azure-key", endpoint: null, resourceName: "resource" })
    mockGetLatimer.mockResolvedValue("latimer-key")
    const configured = await getConfiguredChatProviders()
    expect(configured).toEqual(new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"]))
  })

  it("treats whitespace-only keys as not configured", async () => {
    mockGetOpenAI.mockResolvedValue("   ")
    const configured = await getConfiguredChatProviders()
    expect(configured.has("openai")).toBe(false)
  })

  it("requires both the Azure key and resource name", async () => {
    mockGetAzureOpenAI.mockResolvedValue({ key: "azure-key", endpoint: null, resourceName: null })
    const configured = await getConfiguredChatProviders()
    expect(configured.has("azure")).toBe(false)
  })

  it("fails open when the credential probe throws", async () => {
    mockGetOpenAI.mockRejectedValue(new Error("settings unavailable"))
    const configured = await getConfiguredChatProviders()
    expect(configured).toEqual(new Set(["openai", "google", "amazon-bedrock", "azure", "latimer"]))
  })
})
