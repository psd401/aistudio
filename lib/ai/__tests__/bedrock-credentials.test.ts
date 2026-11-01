/**
 * @jest-environment node
 *
 * Every Bedrock client signs with stored keys when they are configured (outside
 * Lambda) and with the default AWS credential chain otherwise. In ECS the chain
 * is the task role, which the AI SDK's Bedrock provider never reaches on its
 * own — it only reads AWS_ACCESS_KEY_ID env vars, which ECS does not set — so
 * these tests pin the credential that actually signs the outgoing request.
 *
 * Uses the global `jest` (not @jest/globals) so jest.mock hoisting works.
 */

import { generateText } from "ai"

const getBedrockMock = jest.fn()
const chainCredentialsMock = jest.fn()

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getBedrock: () => getBedrockMock(),
  },
  getSettings: async () => ({
    EMBEDDING_MODEL_PROVIDER: "amazon-bedrock",
    EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
    EMBEDDING_DIMENSIONS: "1536",
  }),
}))

jest.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => () => chainCredentialsMock(),
}))

import { getBedrockCredentialProvider } from "@/lib/ai/bedrock-credentials"
import { createProviderModel } from "@/lib/ai/provider-factory"
import { ClaudeAdapter } from "@/lib/streaming/provider-adapters/claude-adapter"
import { generateEmbedding } from "@/lib/ai-helpers"

const CONVERSE_BODY = {
  output: { message: { role: "assistant", content: [{ text: "OK" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
}

const STORED_KEYS = {
  accessKeyId: "stored-access-key-id",
  secretAccessKey: "example-secret-not-real",
  region: "us-east-1",
}
const NO_KEYS = { accessKeyId: null, secretAccessKey: null, region: "us-east-1" }

function captureAuthorization(body: unknown = CONVERSE_BODY): string[] {
  const captured: string[] = []
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const fromInit = new Headers(init?.headers as HeadersInit | undefined).get("authorization")
    const fromRequest = (input as unknown as { headers?: Headers }).headers?.get?.("authorization")
    captured.push(fromInit ?? fromRequest ?? "")
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  return captured
}

const savedEnv = { ...process.env }

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.AWS_LAMBDA_FUNCTION_NAME
  delete process.env.AWS_ACCESS_KEY_ID
  delete process.env.AWS_SECRET_ACCESS_KEY
  delete process.env.AWS_SESSION_TOKEN
  delete process.env.AWS_BEARER_TOKEN_BEDROCK
  chainCredentialsMock.mockResolvedValue({
    accessKeyId: "task-role-access-key-id",
    secretAccessKey: "example-task-role-secret",
    sessionToken: "example-session-token",
  })
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...savedEnv }
})

describe("getBedrockCredentialProvider", () => {
  it("uses stored keys outside Lambda when both are configured", async () => {
    const { source, credentialProvider } = getBedrockCredentialProvider(STORED_KEYS)

    expect(source).toBe("stored-keys")
    await expect(credentialProvider()).resolves.toEqual({
      accessKeyId: "stored-access-key-id",
      secretAccessKey: "example-secret-not-real",
    })
    expect(chainCredentialsMock).not.toHaveBeenCalled()
  })

  it("falls back to the default chain when no keys are stored", async () => {
    const { source, credentialProvider } = getBedrockCredentialProvider(NO_KEYS)

    expect(source).toBe("default-chain")
    await expect(credentialProvider()).resolves.toMatchObject({
      accessKeyId: "task-role-access-key-id",
    })
  })

  it("falls back to the default chain when only one key is stored", () => {
    const { source } = getBedrockCredentialProvider({
      accessKeyId: "stored-access-key-id",
      secretAccessKey: null,
    })
    expect(source).toBe("default-chain")
  })

  it("ignores stored keys in Lambda", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "some-function"
    const { source } = getBedrockCredentialProvider(STORED_KEYS)
    expect(source).toBe("default-chain")
  })
})

describe("Converse clients sign with the resolved credentials", () => {
  const MODEL_ID = "us.anthropic.claude-sonnet-5-5"

  it("provider factory signs with the default chain when no keys are stored", async () => {
    getBedrockMock.mockResolvedValue(NO_KEYS)
    const captured = captureAuthorization()

    const model = await createProviderModel("amazon-bedrock", MODEL_ID)
    const result = await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(result.text).toBe("OK")
    expect(captured[0]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=task-role-access-key-id\/\d{8}\/us-east-1\/bedrock\/aws4_request/
    )
  })

  it("provider factory still signs with stored keys when they are configured", async () => {
    getBedrockMock.mockResolvedValue(STORED_KEYS)
    const captured = captureAuthorization()

    const model = await createProviderModel("amazon-bedrock", MODEL_ID)
    await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(captured[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=stored-access-key-id\//)
    expect(chainCredentialsMock).not.toHaveBeenCalled()
  })

  it("Claude adapter signs with the default chain when no keys are stored", async () => {
    getBedrockMock.mockResolvedValue(NO_KEYS)
    const captured = captureAuthorization()

    const model = await new ClaudeAdapter().createModel(MODEL_ID)
    await generateText({ model, prompt: "Say OK", maxRetries: 0 })

    expect(captured[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=task-role-access-key-id\//)
  })
})

describe("Bedrock embeddings sign with the resolved credentials", () => {
  it("signs with the default chain when no keys are stored", async () => {
    getBedrockMock.mockResolvedValue(NO_KEYS)
    const captured = captureAuthorization({ embedding: [0.1, 0.2], inputTextTokenCount: 2 })

    const embedding = await generateEmbedding("hello")

    expect(embedding).toEqual([0.1, 0.2])
    expect(captured[0]).toMatch(/^AWS4-HMAC-SHA256 Credential=task-role-access-key-id\//)
  })
})
