import { describe, expect, it } from "@jest/globals"
import {
  modelToFormData,
  parseCapabilities,
  parseProviderMetadata,
} from "@/app/(protected)/admin/models/_components/model-detail-form"
import type { SelectAiModel } from "@/types/db-types"

describe("model detail form conversion", () => {
  it("parses JSON and legacy scalar capabilities", () => {
    expect(parseCapabilities('["chat","vision"]')).toEqual(["chat", "vision"])
    expect(parseCapabilities("legacy-capability")).toEqual([
      "legacy-capability",
    ])
  })

  it("discards malformed capability entries and metadata", () => {
    expect(parseCapabilities('["chat",42]')).toEqual(["chat"])
    expect(parseProviderMetadata("{invalid")).toEqual({})
    expect(parseProviderMetadata("null")).toEqual({})
  })

  it("preserves persisted model defaults and advanced settings", () => {
    const model = {
      id: 42,
      name: "GPT Test",
      provider: "openai",
      modelId: "gpt-test",
      description: null,
      capabilities: '["chat"]',
      maxTokens: 8192,
      active: true,
      nexusEnabled: true,
      architectEnabled: false,
      inputCostPer1kTokens: "0.001",
      outputCostPer1kTokens: null,
      cachedInputCostPer1kTokens: null,
      cacheWriteCostPer1kTokens: null,
      averageLatencyMs: 150,
      maxConcurrency: 8,
      supportsBatching: true,
      providerMetadata: { region: "us-east-1" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      pricingUpdatedAt: null,
    } satisfies SelectAiModel

    expect(modelToFormData(model)).toMatchObject({
      architectEnabled: false,
      capabilitiesList: ["chat"],
      description: "",
      inputCostPer1kTokens: "0.001",
      maxTokens: 8192,
      nexusEnabled: true,
      providerMetadata: { region: "us-east-1" },
      supportsBatching: true,
    })
  })
})
