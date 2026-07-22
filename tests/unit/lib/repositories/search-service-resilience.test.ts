const mockExecuteQuery = jest.fn()
const mockGenerateEmbedding = jest.fn()
const mockWarn = jest.fn()

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}))
jest.mock("@/lib/ai-helpers", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}))
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ warn: mockWarn }),
}))

import { hybridSearch, vectorSearch } from "@/lib/repositories/search-service"

describe("repository hybrid search resilience", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test("returns keyword hits when the embedding provider is unavailable", async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error("embedding provider unavailable"))
    mockExecuteQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          chunk_id: 7,
          item_id: 3,
          item_name: "Policy",
          content: "Emergency closure procedure",
          chunk_index: 0,
          metadata: {},
          rank: 0.8,
        },
      ])

    const results = await hybridSearch("closure", {
      repositoryId: 4,
      vectorWeight: 0.7,
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ chunkId: 7 })
    expect(results[0]?.similarity).toBeCloseTo(0.24)
    expect(mockWarn).toHaveBeenCalledWith(
      "Vector search unavailable; returning keyword results",
      expect.objectContaining({ error: "embedding provider unavailable" }),
    )
  })

  test("uses the active generation embedding model for non-canonical repository searches", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([
        {
          id: "d82f145e-c8bc-4f85-8bf3-92b97279ef60",
          embedding_model: "openai:text-embedding-3-small",
          embedding_dimensions: 1536,
        },
      ])
      .mockResolvedValueOnce([])
    mockGenerateEmbedding.mockResolvedValue([0.25, 0.75])

    await vectorSearch("legacy policy", {
      repositoryId: 4,
      canonicalOnly: false,
    })

    expect(mockGenerateEmbedding).toHaveBeenCalledWith("legacy policy", {
      provider: "openai",
      modelId: "text-embedding-3-small",
      dimensions: 1536,
    })
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
  })
})
