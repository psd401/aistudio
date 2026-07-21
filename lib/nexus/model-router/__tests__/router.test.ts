/** @jest-environment node */

const mockGetNexusEnabledModels = jest.fn()
const mockFilterAccessibleResourceIds = jest.fn()
const mockGetConfig = jest.fn()
const mockClassify = jest.fn()
const mockExecuteQuery = jest.fn()

jest.mock("@/lib/db/drizzle", () => ({ getNexusEnabledModels: () => mockGetNexusEnabledModels() }))
jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: (...args: unknown[]) => mockFilterAccessibleResourceIds(...args),
}))
jest.mock("@/lib/db/drizzle-client", () => ({ executeQuery: (...args: unknown[]) => mockExecuteQuery(...args) }))
jest.mock("../config", () => ({ getNexusRouterConfig: () => mockGetConfig() }))
jest.mock("../classifier", () => ({ classifyNexusRequest: (...args: unknown[]) => mockClassify(...args) }))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { mergeRoutedToolNames, routeNexusRequest } from "../router"
import { nexusRouterConfigSchema } from "../types"

const models = [
  { id: 1, name: "GPT Luna", provider: "openai", modelId: "gpt-luna", capabilities: "[]", providerMetadata: { nexusRouterTier: "light" } },
  { id: 2, name: "GPT Terra", provider: "openai", modelId: "gpt-terra", capabilities: "[]", providerMetadata: { nexusRouterTier: "medium" } },
  { id: 3, name: "Claude Sonnet", provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet", capabilities: "[]", providerMetadata: { nexusRouterTier: "medium" } },
  { id: 4, name: "Gemini Flash", provider: "google", modelId: "gemini-flash", capabilities: '["web_search"]', providerMetadata: { nexusRouterTier: "medium" } },
  { id: 5, name: "Nano Banana", provider: "google", modelId: "gemini-3.1-flash-image", capabilities: '["image_generation"]', providerMetadata: { nexusRouterTier: "light" } },
  { id: 6, name: "Gemini Deep Research", provider: "google", modelId: "gemini-deep-research", capabilities: '["deep_research"]', providerMetadata: { nexusRouterTier: "high" } },
  { id: 7, name: "Amazon Nova Lite", provider: "amazon-bedrock", modelId: "us.amazon.nova-lite-v1:0", capabilities: "[]", providerMetadata: { nexusRouterTier: "light" } },
]

const config = nexusRouterConfigSchema.parse({
  families: {
    openai: { light: ["gpt-luna"], medium: ["gpt-terra"], high: [] },
    anthropic: { light: [], medium: ["us.anthropic.claude-sonnet"], high: [] },
    google: { light: [], medium: ["gemini-flash"], high: [] },
  },
  specialists: {
    imageModels: ["gemini-3.1-flash-image"],
    instructionModels: ["gemini-flash"],
    webSearchModels: ["gemini-flash"],
    psdDataConnectorName: "psd-data",
  },
})

describe("Nexus model router", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetNexusEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(models.map(model => String(model.id)))
    mockGetConfig.mockResolvedValue({ config, mode: "active" })
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal_request"], source: "classifier",
    })
  })

  it("merges automatic web search with manually enabled tools without duplicates", () => {
    expect(mergeRoutedToolNames(
      ["codeInterpreter", "webSearch"],
      ["webSearch"]
    )).toEqual(["codeInterpreter", "webSearch"])
  })

  it("constrains Advanced routing to the selected family", async () => {
    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.selectedFamily).toBe("anthropic")
  })

  it("allows Standard Auto tiers to prefer Bedrock-native models", async () => {
    const bedrockFirstConfig = nexusRouterConfigSchema.parse({
      auto: { light: ["us.amazon.nova-lite-v1:0"], medium: [], high: [] },
    })
    mockGetConfig.mockResolvedValue({ config: bedrockFirstConfig, mode: "active" })
    mockClassify.mockResolvedValue({
      intent: "general", tier: "light", confidence: 0.9,
      reasonCodes: ["simple_request"], source: "classifier",
    })

    const result = await routeNexusRequest({
      text: "Define photosynthesis", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })

    expect(result.modelId).toBe("us.amazon.nova-lite-v1:0")
    expect(result.metadata.selectedFamily).toBe("fallback")
  })

  it("uses the image specialist regardless of requested family", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })
    const result = await routeNexusRequest({
      text: "Create an image", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gemini-3.1-flash-image")
  })

  it("automatically attaches the database-backed PSD-data MCP server", async () => {
    mockClassify.mockResolvedValue({
      intent: "psd-data", tier: "medium", confidence: 0.98,
      reasonCodes: ["psd_data_domain"], source: "deterministic",
    })
    mockExecuteQuery.mockResolvedValue([{ id: "54f0f531-f7ab-485e-bd6b-65a95c4bc871", name: "PSD Data" }])
    const result = await routeNexusRequest({
      text: "Get attendance", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })
    expect(result.connectorIds).toEqual(["54f0f531-f7ab-485e-bd6b-65a95c4bc871"])
    expect(result.automaticConnectorIds).toEqual(["54f0f531-f7ab-485e-bd6b-65a95c4bc871"])
    expect(result.metadata.autoAttachedPsdData).toBe(true)
  })

  it("routes current-information requests to Gemini and automatically enables web search", async () => {
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })
    const result = await routeNexusRequest({
      text: "Search the web for today's weather", fallbackModelId: "gpt-terra",
      experienceMode: "standard", requestedFamily: "auto",
      enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gemini-flash")
    expect(result.automaticToolNames).toEqual(["webSearch"])
    expect(result.metadata.autoEnabledWebSearch).toBe(true)
  })

  it("fails clearly when the selected Advanced family cannot perform web search", async () => {
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })
    await expect(routeNexusRequest({
      text: "Browse the web for current policy", fallbackModelId: "gpt-terra",
      experienceMode: "advanced", requestedFamily: "anthropic",
      enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("Web search is not available")
  })

  it("records a proposed route but executes the fallback in shadow mode", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })
    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.proposedModelId).toBe("us.anthropic.claude-sonnet")
  })

  it("stays in the Advanced family when the requested tier is unavailable", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "high", confidence: 0.9,
      reasonCodes: ["complex"], source: "classifier",
    })
    const result = await routeNexusRequest({
      text: "Complex request", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("us.anthropic.claude-sonnet")
    expect(result.metadata.fallbackUsed).toBe(true)
  })

  it("does not silently cross an unavailable Advanced family", async () => {
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "2", "4", "5", "6"])
    await expect(routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("anthropic family")
  })

  it("keeps shadow mode non-disruptive when a proposed family is unavailable", async () => {
    mockGetConfig.mockResolvedValue({ config, mode: "shadow" })
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "2", "4", "5", "6"])
    const result = await routeNexusRequest({
      text: "Help", fallbackModelId: "gpt-terra", experienceMode: "advanced",
      requestedFamily: "anthropic", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).toBe("gpt-terra")
    expect(result.metadata.fallbackUsed).toBe(true)
  })

  it("never routes an ordinary request to a specialist-only Deep Research model", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "high", confidence: 0.9,
      reasonCodes: ["complex"], source: "classifier",
    })
    const result = await routeNexusRequest({
      text: "Complex request", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })
    expect(result.modelId).not.toBe("gemini-deep-research")
    expect(result.modelId).toBe("gpt-terra")
  })

  it("fails clearly instead of answering an image request with a text model", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })
    mockFilterAccessibleResourceIds.mockResolvedValue(["1", "2", "3", "4", "6"])
    await expect(routeNexusRequest({
      text: "Create an image", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("Image generation is not available")
  })

  it("fails clearly instead of silently answering without PSD-data", async () => {
    mockClassify.mockResolvedValue({
      intent: "psd-data", tier: "medium", confidence: 0.98,
      reasonCodes: ["psd_data_domain"], source: "deterministic",
    })
    mockExecuteQuery.mockRejectedValue(new Error("database unavailable"))
    await expect(routeNexusRequest({
      text: "Get attendance", fallbackModelId: "gpt-terra", experienceMode: "standard",
      requestedFamily: "auto", enabledConnectorIds: [], userId: 7,
    })).rejects.toThrow("PSD Data is not configured")
  })
})
