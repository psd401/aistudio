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
    expect(deterministicClassify("Do you have an MCP connection?")?.intent).toBe("psd-data")
    expect(deterministicClassify("Build a differentiated lesson plan")?.intent).toBe("instruction")
  })

  it("routes explicit searches and time-sensitive facts to web search", () => {
    expect(deterministicClassify("Search the web for the latest district guidance")?.intent)
      .toBe("web-search")
    expect(deterministicClassify("What is today's weather forecast for Tacoma?")?.intent)
      .toBe("web-search")
    expect(deterministicClassify("What is the cost today for a first-class stamp?")?.intent)
      .toBe("web-search")
    expect(deterministicClassify("Show me technology news this week")?.intent)
      .toBe("web-search")
    expect(deterministicClassify("Improve the current paragraph in my draft")).toBeNull()
    expect(deterministicClassify("Summarize the current results in this spreadsheet")).toBeNull()
  })

  it("treats a pasted URL as a fetch, not a web search (#1696)", async () => {
    // Routing a "open this link" turn as web-search requires a web-search-capable
    // model and throws NexusSpecialistUnavailableError when none is accessible —
    // killing the turn before the model can use the universal `web_fetch` tool.
    // That hard failure was the reported bug (FS#164087 / FS#164086).
    for (const message of [
      "Open https://example.com and quote the main heading",
      "Summarize http://example.org/article for me",
      "What does this say? https://example.com/page",
      "Please read https://example.com/docs/guide and explain it",
    ]) {
      expect(deterministicClassify(message)).toMatchObject({
        intent: "general",
        reasonCodes: ["explicit_url_web_fetch"],
      });
    }
  });

  it("does not spend a classifier call on a pasted URL (#1696)", async () => {
    // The LLM classifier labels "open <url>" as web-search, so the deterministic
    // rule must short-circuit it rather than merely reorder the local patterns.
    const decision = await classifyNexusRequest(
      "Open https://example.com and quote the main heading",
      config
    );
    expect(decision).toMatchObject({ intent: "general", source: "deterministic" });
    expect(mockCreateProviderModel).not.toHaveBeenCalled();
  });

  it("still routes an explicit search to web search even when a link is present (#1696)", () => {
    expect(
      deterministicClassify(
        "Search the web for district guidance, then compare it with https://example.com"
      )?.intent
    ).toBe("web-search");
  });

  it("does not let a pasted URL shadow a more specific domain or complexity signal (#1696)", () => {
    // A URL says the turn needs a FETCH; it says nothing about the subject or
    // how hard the question is. Classifying on the link alone would silently
    // downgrade both the specialist and the tier.
    expect(
      deterministicClassify(
        "Using the rubric at https://example.com/rubric.pdf, build a differentiated lesson plan"
      )
    ).toMatchObject({ intent: "instruction" });

    expect(
      deterministicClassify(
        "Do a full architecture review of this migration; the endpoint is https://example.com/v1"
      )
    ).toMatchObject({
      intent: "general",
      tier: "high",
      reasonCodes: ["explicit_url_web_fetch"],
    });

    expect(deterministicClassify("What is https://example.com/page")).toMatchObject({
      intent: "general",
      tier: "light",
      reasonCodes: ["explicit_url_web_fetch"],
    });
  });

  it("prefers the link over an implicit currency signal (#1696)", () => {
    // Without a URL this is a web search; with one, the user has already named
    // the page to read, and routing it as web-search kills the turn whenever no
    // web-search-capable model is accessible.
    expect(deterministicClassify("What is the latest guidance?")?.intent).toBe("web-search");
    expect(
      deterministicClassify("What is the latest guidance? See https://example.com/guidance")
    ).toMatchObject({ intent: "general", reasonCodes: ["explicit_url_web_fetch"] });
  });

  it("recognizes an edit instruction when an image is attached", async () => {
    const decision = await classifyNexusRequest("Make this brighter", config, { hasImageInput: true })
    expect(decision).toMatchObject({ intent: "image", source: "deterministic" })
    expect(mockCreateProviderModel).not.toHaveBeenCalled()
  })

  it("recognizes an elliptical edit when a previous generated image is available", async () => {
    const decision = await classifyNexusRequest("Make it brighter", config, {
      hasPreviousGeneratedImage: true,
    })
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
