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

import { hybridSearch } from "@/lib/repositories/search-service"

describe("repository hybrid search resilience", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test("returns keyword hits when the embedding provider is unavailable", async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error("embedding provider unavailable"))
    mockExecuteQuery.mockResolvedValue([
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
})
