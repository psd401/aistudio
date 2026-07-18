/** @jest-environment node */

import {
  inferModelFamily,
  inferModelTier,
  isExecutableTextModel,
  selectRoutedTextModel,
  type RoutableModel,
} from "../core"

const models: RoutableModel[] = [
  { id: 1, name: "Nova Micro", provider: "amazon-bedrock", modelId: "us.amazon.nova-micro-v1:0", capabilities: "[]", providerMetadata: { modelRouterTier: "light" } },
  { id: 2, name: "Claude Sonnet", provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet", capabilities: '["web_search"]', providerMetadata: { modelRouterTier: "medium", supports_function_calling: true } },
  { id: 3, name: "GPT Sol", provider: "openai", modelId: "gpt-sol", capabilities: "[]", providerMetadata: { modelRouterTier: "high" } },
  { id: 4, name: "Gemini Flash", provider: "google", modelId: "gemini-flash", capabilities: "[]", providerMetadata: { modelRouterTier: "medium" } },
  { id: 5, name: "Nano Banana", provider: "google", modelId: "gemini-flash-image", capabilities: '["image_generation"]', providerMetadata: { modelRouterTier: "light" } },
]

describe("shared model router core", () => {
  it("infers provider families and configured tiers", () => {
    expect(inferModelFamily(models[1])).toBe("anthropic")
    expect(inferModelFamily(models[3])).toBe("google")
    expect(inferModelTier(models[2])).toBe("high")
  })

  it("excludes specialist-only image endpoints from text routing", () => {
    expect(isExecutableTextModel(models[4])).toBe(false)
  })

  it("honors configured candidates before inferred tier candidates", () => {
    const result = selectRoutedTextModel({
      models,
      configuredCandidateIds: ["gpt-sol"],
      accessibleIds: new Set(models.map(model => String(model.id))),
      family: "auto",
      tier: "medium",
      fallbackModelId: "1",
    })
    expect(result?.model.id).toBe(3)
    expect(result?.fallbackUsed).toBe(false)
  })

  it("never crosses an Advanced family constraint", () => {
    const result = selectRoutedTextModel({
      models,
      configuredCandidateIds: [],
      accessibleIds: new Set(models.map(model => String(model.id))),
      family: "anthropic",
      tier: "high",
      fallbackModelId: "3",
    })
    expect(result?.model.id).toBe(2)
    expect(inferModelFamily(result!.model)).toBe("anthropic")
  })

  it("filters candidates that explicitly lack required capabilities", () => {
    const noTools = { ...models[1], providerMetadata: { ...models[1].providerMetadata, supports_function_calling: false } }
    const result = selectRoutedTextModel({
      models: [noTools, models[3]],
      configuredCandidateIds: [noTools.modelId],
      accessibleIds: new Set(["2", "4"]),
      family: "auto",
      tier: "medium",
      fallbackModelId: "2",
      requirements: { requiresFunctionCalling: true },
    })
    expect(result?.model.id).toBe(4)
  })
})
