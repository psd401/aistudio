/** @jest-environment node */

const mockGenerateText = jest.fn()
const mockCreateProviderModel = jest.fn()

jest.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  tool: (definition: unknown) => definition,
}))
jest.mock("@/lib/ai/provider-factory", () => ({
  createProviderModel: (...args: unknown[]) => mockCreateProviderModel(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

import { classifyNexusRequest, deterministicClassify, heuristicFallback } from "../classifier"
import { nexusRouterConfigSchema } from "../types"

const config = nexusRouterConfigSchema.parse({})

describe("Nexus request classifier", () => {
  beforeEach(() => jest.clearAllMocks())

  it("routes explicit image requests without spending a classifier call", async () => {
    const decision = await classifyNexusRequest("Create an image of a school garden", config)
    expect(decision).toMatchObject({ intent: "image", source: "deterministic" })
    expect(mockCreateProviderModel).not.toHaveBeenCalled()
  })

  it("routes PSD-data and instructional requests deterministically", () => {
    expect(deterministicClassify("Show attendance for this student")?.intent).toBe("psd-data")
    expect(deterministicClassify("Build a differentiated lesson plan")?.intent).toBe("instruction")
  })

  it("recognizes an edit instruction when an image is attached", async () => {
    const decision = await classifyNexusRequest("Make this brighter", config, { hasImageInput: true })
    expect(decision).toMatchObject({ intent: "image", source: "deterministic" })
    expect(mockCreateProviderModel).not.toHaveBeenCalled()
  })

  it("uses Nova Micro for ambiguous requests", async () => {
    mockCreateProviderModel.mockResolvedValue({ modelId: "nova" })
    mockGenerateText.mockResolvedValue({
      text: '{"intent":"general","tier":"high","confidence":0.91,"reasonCodes":["multi_stage"]}',
    })
    const decision = await classifyNexusRequest("Compare these approaches and recommend a migration strategy", config)
    expect(mockCreateProviderModel).toHaveBeenCalledWith("amazon-bedrock", "us.amazon.nova-micro-v1:0")
    expect(decision).toMatchObject({ tier: "high", source: "classifier", confidence: 0.91 })
  })

  it("prefers the forced route tool result over free-form text", async () => {
    mockCreateProviderModel.mockResolvedValue({ modelId: "nova" })
    mockGenerateText.mockResolvedValue({
      text: "not json",
      toolCalls: [{
        toolName: "route_request",
        input: { intent: "general", tier: "light", confidence: 0.88, reasonCodes: ["simple"] },
      }],
    })
    const decision = await classifyNexusRequest("Polish this sentence for a different audience", config)
    expect(decision).toMatchObject({ tier: "light", source: "classifier", confidence: 0.88 })
  })

  it("fails safely to a medium heuristic when the classifier is unavailable", async () => {
    mockCreateProviderModel.mockRejectedValue(new Error("Bedrock unavailable"))
    const decision = await classifyNexusRequest("Please help me improve this paragraph for my audience", config)
    expect(decision).toMatchObject({ tier: "medium", source: "fallback" })
  })

  it("keeps obvious short requests on the light tier", () => {
    expect(heuristicFallback("Define photosynthesis").tier).toBe("light")
  })
})
