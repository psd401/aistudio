import { describe, it, expect, beforeEach } from "@jest/globals"

/* eslint-disable no-var */
var mockSend = jest.fn()
var mockGetSetting = jest.fn()
/* eslint-enable no-var */

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  __esModule: true,
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn((input: unknown) => ({
    __command: "InvokeModel",
    input,
  })),
}))

jest.mock("@/lib/settings-manager", () => ({
  __esModule: true,
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}))

jest.mock("@/lib/nexus/memory/memory-embeddings", () =>
  jest.requireActual("@/lib/nexus/memory/memory-embeddings"),
)

import {
  __resetMemoryEmbeddingClient,
  DEFAULT_MEMORY_EMBEDDING_MODEL_ID,
  generateMemoryEmbedding,
  getMemoryEmbeddingModelId,
  MEMORY_EMBEDDING_DIMENSIONS,
} from "@/lib/nexus/memory/memory-embeddings"
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"

function bedrockResponse(embedding: number[]) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ embedding })),
  }
}

const validEmbedding = Array.from(
  { length: MEMORY_EMBEDDING_DIMENSIONS },
  () => 0.02,
)

describe("Nexus memory embeddings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetMemoryEmbeddingClient()
    mockGetSetting.mockResolvedValue(null)
  })

  it("uses the dedicated Titan V2 setting with a stable default", async () => {
    expect(await getMemoryEmbeddingModelId()).toBe(
      DEFAULT_MEMORY_EMBEDDING_MODEL_ID,
    )
    mockGetSetting.mockResolvedValue("custom-memory-model")
    expect(await getMemoryEmbeddingModelId()).toBe("custom-memory-model")
  })

  it("requests a normalized 512-dimensional embedding", async () => {
    mockSend.mockResolvedValue(bedrockResponse(validEmbedding))

    await expect(generateMemoryEmbedding("remember this")).resolves.toHaveLength(
      MEMORY_EMBEDDING_DIMENSIONS,
    )
    const call = (InvokeModelCommand as unknown as jest.Mock).mock.calls[0][0]
    const body = JSON.parse(call.body)
    expect(call.modelId).toBe(DEFAULT_MEMORY_EMBEDDING_MODEL_ID)
    expect(body).toMatchObject({
      inputText: "remember this",
      dimensions: 512,
      normalize: true,
    })
  })

  it("rejects configuration drift from the fixed vector dimension", async () => {
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "MEMORY_EMBEDDING_DIMENSIONS" ? "1024" : null,
    )

    await expect(generateMemoryEmbedding("remember this")).rejects.toThrow(
      "must remain 512",
    )
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("rejects empty input and malformed Bedrock vectors", async () => {
    await expect(generateMemoryEmbedding("   ")).rejects.toThrow("empty")
    mockSend.mockResolvedValue(bedrockResponse([0.1, 0.2]))
    await expect(generateMemoryEmbedding("valid text")).rejects.toThrow(
      "expected 512 dimensions",
    )
    mockSend.mockResolvedValue(
      bedrockResponse(
        validEmbedding.map((value, index) =>
          index === 0 ? Number.NaN : value,
        ),
      ),
    )
    await expect(generateMemoryEmbedding("valid text")).rejects.toThrow(
      "expected 512 dimensions",
    )
  })
})
