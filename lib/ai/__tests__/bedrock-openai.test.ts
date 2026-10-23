/**
 * @jest-environment node
 *
 * OpenAI GPT models on Amazon Bedrock go through the OpenAI Responses API on
 * bedrock-runtime, signed with SigV4 — not through Converse and not through
 * bedrock-mantle. These tests pin the request that actually leaves the process.
 *
 * Uses the global `jest` (not @jest/globals) so jest.mock hoisting works.
 */

import { generateText } from "ai"

const getBedrockMock = jest.fn()

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getBedrock: () => getBedrockMock(),
  },
}))

import {
  createBedrockOpenAIModel,
  getBedrockOpenAIProviderOptions,
  isBedrockOpenAIModel,
} from "@/lib/ai/bedrock-openai"
import {
  inferModelFamily,
  inferModelTier,
  modelSupportsProviderNativeTool,
} from "@/lib/ai/model-router/core"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { ClaudeAdapter } from "@/lib/streaming/provider-adapters/claude-adapter"

const RESPONSES_API_BODY = {
  id: "resp_test",
  object: "response",
  created_at: 1_760_000_000,
  model: "us.openai.gpt-5.5",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 8,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 10,
  },
}

type CapturedRequest = { url: string; headers: Headers; body: Record<string, unknown> }

function captureFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  // aws4fetch hands fetch the signed Request it built; under tests/setup.ts that
  // is the plain mock Request (url, headers, body as given).
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input as unknown as { url: string; headers: Headers; body: unknown }
    captured.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(String(request.body)),
    })
    return new Response(JSON.stringify(RESPONSES_API_BODY), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  return captured
}

describe("isBedrockOpenAIModel", () => {
  it.each([
    "us.openai.gpt-5.5",
    "global.openai.gpt-6-sol",
    "openai.gpt-5.6-luna",
    "us.openai.gpt-6.1-sol",
  ])("routes %s to the Responses API", (modelId) => {
    expect(isBedrockOpenAIModel(modelId)).toBe(true)
  })

  it.each([
    "openai.gpt-oss-120b-1:0",
    "us.anthropic.claude-sonnet-5",
    "gpt-5.5",
    "amazon.nova-pro-v1:0",
  ])("leaves %s on its existing path", (modelId) => {
    expect(isBedrockOpenAIModel(modelId)).toBe(false)
  })
})

describe("createBedrockOpenAIModel", () => {
  beforeEach(() => {
    getBedrockMock.mockResolvedValue({
      accessKeyId: "test-access-key-id",
      secretAccessKey: "example-secret-not-real",
      region: "us-east-1",
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("calls the bedrock-runtime Responses API with a SigV4 signature, not a Bearer key", async () => {
    const captured = captureFetch()
    const model = await createBedrockOpenAIModel("us.openai.gpt-5.5")

    const result = await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(result.text).toBe("OK")
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses"
    )
    const authorization = captured[0].headers.get("authorization") ?? ""
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key-id\/\d{8}\/us-east-1\/bedrock\/aws4_request/)
    expect(authorization).not.toMatch(/Bearer/)
    expect(captured[0].body.model).toBe("us.openai.gpt-5.5")
  })

  it("sends store:false by default so no request references server-stored items", async () => {
    const captured = captureFetch()
    const model = await createBedrockOpenAIModel("us.openai.gpt-5.5")

    await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(captured[0].body.store).toBe(false)
  })

  it("lets a caller's reasoning effort through alongside the store default", async () => {
    const captured = captureFetch()
    const model = await createBedrockOpenAIModel("us.openai.gpt-5.5")

    await generateText({
      model,
      prompt: "Say OK",
      maxRetries: 0,
      providerOptions: getBedrockOpenAIProviderOptions("high") as never,
    })

    expect(captured[0].body.store).toBe(false)
    expect(captured[0].body.reasoning).toEqual({ effort: "high" })
  })

  it("treats prefixed IDs as reasoning models: developer role, no temperature", async () => {
    // The OpenAI provider recognises reasoning models only by a `gpt-5`/`o3`
    // prefix, which `us.openai.gpt-5.5` lacks.
    const captured = captureFetch()
    const model = await createBedrockOpenAIModel("us.openai.gpt-5.5")

    await generateText({
      model,
      system: "Be brief.",
      prompt: "Say OK",
      temperature: 0.3,
      maxRetries: 0,
    })

    const input = captured[0].body.input as Array<{ role?: string }>
    expect(input[0].role).toBe("developer")
    expect(captured[0].body.temperature).toBeUndefined()
  })

  it("uses the configured Bedrock region", async () => {
    getBedrockMock.mockResolvedValue({
      accessKeyId: "test-access-key-id",
      secretAccessKey: "example-secret-not-real",
      region: "us-west-2",
    })
    const captured = captureFetch()
    const model = await createBedrockOpenAIModel("us.openai.gpt-5.5")

    await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(captured[0].url).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses"
    )
  })

  it("is what createProviderModel('amazon-bedrock') returns for a GPT model", async () => {
    const captured = captureFetch()
    const model = await createProviderModel("amazon-bedrock", "us.openai.gpt-5.5")

    await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(captured[0].url).toMatch(/bedrock-runtime\.us-east-1\.amazonaws\.com\/openai\/v1\/responses$/)
  })
})

describe("ClaudeAdapter for Bedrock-hosted GPT models", () => {
  const adapter = new ClaudeAdapter()

  it("advertises reasoning and the same 5-minute budget as GPT-5 on the direct path", () => {
    const capabilities = adapter.getCapabilities("us.openai.gpt-5.5")
    expect(capabilities.supportsReasoning).toBe(true)
    expect(capabilities.maxTimeoutMs).toBe(300_000)
    expect(capabilities.supportedTools).toEqual([])
  })

  it("passes reasoning effort as OpenAI provider options, defaulting to medium", () => {
    expect(adapter.getProviderOptions("us.openai.gpt-5.5", {}).openai).toEqual({
      reasoningEffort: "medium",
    })
    expect(
      adapter.getProviderOptions("us.openai.gpt-5.5", { reasoningEffort: "low" }).openai
    ).toEqual({ reasoningEffort: "low" })
  })

  it("does not add OpenAI options to Claude models", () => {
    expect(adapter.getProviderOptions("us.anthropic.claude-sonnet-5", {}).openai).toBeUndefined()
  })
})

describe("model router treatment of Bedrock-hosted GPT models", () => {
  const model = {
    id: 1,
    name: "GPT-6 Sol (Bedrock)",
    provider: "amazon-bedrock",
    modelId: "us.openai.gpt-6-sol",
    capabilities: null,
    providerMetadata: null,
  }

  it("counts as the ChatGPT family so family requests can select it", () => {
    expect(inferModelFamily(model)).toBe("openai")
  })

  it("derives its tier from the model name", () => {
    expect(inferModelTier(model)).toBe("high")
    expect(inferModelTier({ ...model, name: "GPT-6 Luna (Bedrock)", modelId: "us.openai.gpt-6-luna" })).toBe("light")
  })

  it("is never chosen for hosted web search or code interpreter, which bedrock-runtime lacks", () => {
    expect(modelSupportsProviderNativeTool(model, "webSearch")).toBe(false)
    expect(modelSupportsProviderNativeTool(model, "codeInterpreter")).toBe(false)
  })
})
