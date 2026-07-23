/** @jest-environment node */

const mockGetSettings = jest.fn()
const mockGetAIModelById = jest.fn()
const mockGetArchitectEnabledModels = jest.fn()
const mockFilterAccessibleResourceIds = jest.fn()
const mockClassify = jest.fn()

jest.mock("@/lib/settings-manager", () => ({ getSettings: (...args: unknown[]) => mockGetSettings(...args) }))
jest.mock("@/lib/db/drizzle", () => ({
  getAIModelById: (...args: unknown[]) => mockGetAIModelById(...args),
  getArchitectEnabledModels: () => mockGetArchitectEnabledModels(),
}))
jest.mock("@/lib/db/drizzle/resource-access", () => ({
  filterAccessibleResourceIds: (...args: unknown[]) => mockFilterAccessibleResourceIds(...args),
}))
jest.mock("@/lib/nexus/model-router/classifier", () => ({
  classifyNexusRequest: (...args: unknown[]) => mockClassify(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { routeAssistantArchitectModel } from "../model-router"
import { nexusRouterConfigSchema } from "@/lib/nexus/model-router/types"

const models = [
  { id: 1, name: "Nova Micro", provider: "amazon-bedrock", modelId: "nova-micro", active: true, architectEnabled: true, capabilities: "[]", providerMetadata: { modelRouterTier: "light" } },
  { id: 2, name: "Claude Sonnet", provider: "amazon-bedrock", modelId: "claude-sonnet", active: true, architectEnabled: true, capabilities: "[]", providerMetadata: { modelRouterTier: "medium", supports_function_calling: true } },
  { id: 3, name: "GPT Sol", provider: "openai", modelId: "gpt-sol", active: true, architectEnabled: true, capabilities: "[]", providerMetadata: { modelRouterTier: "high" } },
  { id: 4, name: "Gemini Flash", provider: "google", modelId: "gemini-flash", active: true, architectEnabled: true, capabilities: '["web_search"]', providerMetadata: { modelRouterTier: "medium" } },
  { id: 5, name: "Nano Banana", provider: "google", modelId: "gemini-flash-image", active: true, architectEnabled: true, capabilities: '["image_generation"]', providerMetadata: { modelRouterTier: "light" } },
]
const config = nexusRouterConfigSchema.parse({
  auto: { light: ["nova-micro"], medium: ["claude-sonnet"], high: ["gpt-sol"] },
  families: {
    openai: { light: [], medium: [], high: ["gpt-sol"] },
    anthropic: { light: [], medium: ["claude-sonnet"], high: [] },
    google: { light: [], medium: ["gemini-flash"], high: [] },
  },
  specialists: { instructionModels: ["gemini-flash"] },
})

describe("Assistant Architect model router", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAIModelById.mockImplementation(async (id: number) => models.find(model => model.id === id) ?? null)
    mockGetArchitectEnabledModels.mockResolvedValue(models)
    mockFilterAccessibleResourceIds.mockResolvedValue(new Set(models.map(model => String(model.id))))
    mockGetSettings.mockResolvedValue({
      NEXUS_ROUTER_CONFIG_V1: JSON.stringify(config),
      ASSISTANT_ARCHITECT_ROUTER_MODE: "active",
    })
    mockClassify.mockResolvedValue({
      intent: "general", tier: "medium", confidence: 0.9,
      reasonCodes: ["normal"], source: "classifier",
    })
  })

  it("preserves exact prompt models for legacy assistants", async () => {
    const result = await routeAssistantArchitectModel({
      text: "Help", userId: 7, fallbackModelDbId: 3, routingMode: "legacy",
    })
    expect(result.modelId).toBe("gpt-sol")
    expect(result.metadata.reasonCodes).toContain("legacy_pinned_model")
    expect(mockClassify).not.toHaveBeenCalled()
  })

  it("routes Standard requests across eligible model families", async () => {
    const result = await routeAssistantArchitectModel({
      text: "Help", userId: 7, fallbackModelDbId: 1, routingMode: "standard",
    })
    expect(result.modelId).toBe("claude-sonnet")
    expect(result.metadata.tier).toBe("medium")
  })

  it("uses the configured Gemini specialist for instructional prompts", async () => {
    mockClassify.mockResolvedValue({
      intent: "instruction", tier: "medium", confidence: 0.98,
      reasonCodes: ["instruction_domain"], source: "deterministic",
    })
    const result = await routeAssistantArchitectModel({
      text: "Create a rubric", userId: 7, fallbackModelDbId: 1, routingMode: "standard",
    })
    expect(result.modelId).toBe("gemini-flash")
  })

  it("falls back to another eligible model when the instruction specialist is unavailable", async () => {
    mockClassify.mockResolvedValue({
      intent: "instruction", tier: "medium", confidence: 0.98,
      reasonCodes: ["instruction_domain"], source: "deterministic",
    })
    mockFilterAccessibleResourceIds.mockResolvedValue(
      new Set(models.filter(model => model.id !== 4).map(model => String(model.id)))
    )
    const result = await routeAssistantArchitectModel({
      text: "Create a rubric", userId: 7, fallbackModelDbId: 1, routingMode: "standard",
    })
    expect(result.modelId).toBe("claude-sonnet")
    expect(result.metadata.fallbackUsed).toBe(true)
  })

  it("constrains Advanced routing to the selected family", async () => {
    mockClassify.mockResolvedValue({
      intent: "general", tier: "high", confidence: 0.9,
      reasonCodes: ["complex"], source: "classifier",
    })
    const result = await routeAssistantArchitectModel({
      text: "Analyze this", userId: 7, fallbackModelDbId: 1,
      routingMode: "advanced", requestedFamily: "anthropic",
    })
    expect(result.modelId).toBe("claude-sonnet")
    expect(result.metadata.selectedFamily).toBe("anthropic")
  })

  it("keeps image intent on a text model so the image tool can run", async () => {
    mockClassify.mockResolvedValue({
      intent: "image", tier: "medium", confidence: 0.99,
      reasonCodes: ["explicit_image_request"], source: "deterministic",
    })
    const result = await routeAssistantArchitectModel({
      text: "Create an image", userId: 7, fallbackModelDbId: 1, routingMode: "standard",
      requirements: { requiresFunctionCalling: true },
    })
    expect(result.modelId).toBe("claude-sonnet")
    expect(result.modelId).not.toContain("image")
  })

  it("selects a web-search-capable model when the author enabled the tool", async () => {
    mockClassify.mockResolvedValue({
      intent: "web-search", tier: "medium", confidence: 0.96,
      reasonCodes: ["current_web_information"], source: "deterministic",
    })
    const result = await routeAssistantArchitectModel({
      text: "Search the web for current guidance", userId: 7,
      fallbackModelDbId: 1, routingMode: "standard",
      requirements: { requiredTools: ["webSearch"] },
    })
    expect(result.modelId).toBe("gemini-flash")
    expect(result.metadata.requiredTools).toEqual(["webSearch"])
  })

  it("records proposals without changing execution in shadow mode", async () => {
    mockGetSettings.mockResolvedValue({
      NEXUS_ROUTER_CONFIG_V1: JSON.stringify(config),
      ASSISTANT_ARCHITECT_ROUTER_MODE: "shadow",
    })
    const result = await routeAssistantArchitectModel({
      text: "Help", userId: 7, fallbackModelDbId: 1, routingMode: "standard",
    })
    expect(result.modelId).toBe("nova-micro")
    expect(result.metadata.proposedModelId).toBe("claude-sonnet")
  })
})
