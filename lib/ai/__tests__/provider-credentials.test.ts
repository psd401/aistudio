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

  it("includes google without an API key when Vertex AI WIF is configured", async () => {
    const vertexEnv = {
      GOOGLE_VERTEX_WIF_AUDIENCE: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/vertex-ai",
      GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL: "aistudio-vertex@psd-aistudio-dev.iam.gserviceaccount.com",
      GOOGLE_VERTEX_PROJECT_ID: "psd-aistudio-dev",
      AWS_REGION: "us-east-1",
    }
    const saved = Object.fromEntries(Object.keys(vertexEnv).map((k) => [k, process.env[k]]))
    Object.assign(process.env, vertexEnv)
    try {
      const configured = await getConfiguredChatProviders()
      expect(configured.has("google")).toBe(true)
      expect(mockGetGoogleAI).not.toHaveBeenCalled()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it("treats whitespace-only keys as not configured", async () => {
    mockGetOpenAI.mockResolvedValue("   ")
    mockGetGoogleAI.mockResolvedValue("   ")
    const configured = await getConfiguredChatProviders()
    expect(configured.has("openai")).toBe(false)
    expect(configured.has("google")).toBe(false)
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
