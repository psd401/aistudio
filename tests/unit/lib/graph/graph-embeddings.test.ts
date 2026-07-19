/**
 * Unit tests for the direct-Bedrock graph embedding helper (Issue #1252).
 * The AWS SDK client is mocked; the helper itself runs for real (the global
 * jest.setup.js mock of this module is overridden with requireActual).
 */
import { describe, it, expect, beforeEach } from "@jest/globals"

/* eslint-disable no-var */
var mockSend = jest.fn()
var mockGetSetting = jest.fn()
/* eslint-enable no-var */

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  __esModule: true,
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn((input: unknown) => ({ __command: "InvokeModel", input })),
}))

jest.mock("@/lib/settings-manager", () => ({
  __esModule: true,
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}))

// Override the global jest.setup.js mock of this module with the real thing.
jest.mock("@/lib/graph/graph-embeddings", () =>
  jest.requireActual("@/lib/graph/graph-embeddings")
)

import {
  generateGraphEmbedding,
  getGraphEmbeddingModelId,
  GRAPH_EMBEDDING_DIMENSIONS,
  DEFAULT_GRAPH_EMBEDDING_MODEL_ID,
  __resetGraphEmbeddingClient,
} from "@/lib/graph/graph-embeddings"
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"

function bedrockResponse(embedding: number[]) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 3 })),
  }
}

const validEmbedding = new Array(GRAPH_EMBEDDING_DIMENSIONS).fill(0.02)

describe("graph-embeddings", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetGraphEmbeddingClient()
    mockGetSetting.mockResolvedValue(null)
  })

  describe("getGraphEmbeddingModelId", () => {
    it("returns the configured setting when present", async () => {
      mockGetSetting.mockResolvedValue("amazon.titan-embed-text-v2:0")
      expect(await getGraphEmbeddingModelId()).toBe("amazon.titan-embed-text-v2:0")
    })

    it("falls back to the Titan V2 default when the setting is unset", async () => {
      mockGetSetting.mockResolvedValue(null)
      expect(await getGraphEmbeddingModelId()).toBe(DEFAULT_GRAPH_EMBEDDING_MODEL_ID)
    })

    it("trims and falls back on a whitespace-only setting", async () => {
      mockGetSetting.mockResolvedValue("   ")
      expect(await getGraphEmbeddingModelId()).toBe(DEFAULT_GRAPH_EMBEDDING_MODEL_ID)
    })
  })

  describe("generateGraphEmbedding", () => {
    it("requests 512 dims + normalize and returns the embedding", async () => {
      mockSend.mockResolvedValue(bedrockResponse(validEmbedding))

      const result = await generateGraphEmbedding("Technology Committee")

      expect(result).toHaveLength(GRAPH_EMBEDDING_DIMENSIONS)
      // Inspect the InvokeModelCommand body we constructed.
      const call = (InvokeModelCommand as unknown as jest.Mock).mock.calls[0][0]
      const body = JSON.parse(call.body)
      expect(body.dimensions).toBe(512)
      expect(body.normalize).toBe(true)
      expect(body.inputText).toBe("Technology Committee")
      expect(call.modelId).toBe(DEFAULT_GRAPH_EMBEDDING_MODEL_ID)
    })

    it("throws on empty input without calling Bedrock", async () => {
      await expect(generateGraphEmbedding("   ")).rejects.toThrow(/empty/)
      expect(mockSend).not.toHaveBeenCalled()
    })

    it("throws when the returned vector has the wrong dimension", async () => {
      mockSend.mockResolvedValue(bedrockResponse([0.1, 0.2, 0.3]))
      await expect(generateGraphEmbedding("x")).rejects.toThrow(/unexpected embedding shape/)
    })

    it("throws instead of crashing when the response body decodes to null", async () => {
      mockSend.mockResolvedValue({ body: new TextEncoder().encode("null") })
      await expect(generateGraphEmbedding("x")).rejects.toThrow(/unexpected embedding shape/)
    })

    it("propagates Bedrock errors (so callers can degrade)", async () => {
      mockSend.mockRejectedValue(new Error("AccessDeniedException"))
      await expect(generateGraphEmbedding("x")).rejects.toThrow(/AccessDeniedException/)
    })

    it("caps input length before sending", async () => {
      mockSend.mockResolvedValue(bedrockResponse(validEmbedding))
      await generateGraphEmbedding("y".repeat(20000))
      const call = (InvokeModelCommand as unknown as jest.Mock).mock.calls[0][0]
      const body = JSON.parse(call.body)
      expect(body.inputText.length).toBeLessThanOrEqual(8000)
    })
  })
})
