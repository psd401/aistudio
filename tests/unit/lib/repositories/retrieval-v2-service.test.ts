/** @jest-environment node */

import type { RepositoryReranker } from "@/lib/repositories/retrieval-v2/bedrock-reranker";

const mockExecuteQuery = jest.fn();
const mockGetAccessibleRepositories = jest.fn();
const mockGetUser = jest.fn();
const mockWarn = jest.fn();
const mockGetConfig = jest.fn();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}));
jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: (...args: unknown[]) =>
    mockGetAccessibleRepositories(...args),
  getUserByCognitoSub: (...args: unknown[]) => mockGetUser(...args),
}));
jest.mock("@/lib/ai-helpers", () => ({
  generateEmbedding: jest.fn(),
}));
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: () => mockGetConfig(),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ warn: mockWarn }),
}));

import { retrieveRepositoryContent } from "@/lib/repositories/retrieval-v2/service";

const generationId = "11111111-2222-4333-8444-555555555555";
const itemVersionId = "22222222-3333-4444-8555-666666666666";

function row(chunkId: number, score: number, chunkIndex = chunkId) {
  return {
    chunk_id: chunkId,
    repository_id: 7,
    repository_name: "District Policies",
    generation_id: generationId,
    item_id: 12,
    item_stable_id: "policy-handbook",
    item_name: "Policy Handbook",
    item_version_id: itemVersionId,
    version_number: 4,
    artifact_id: "33333333-4444-4555-8666-777777777777",
    content: `Policy content ${chunkId}`,
    context_prefix: `Page ${chunkIndex + 1}`,
    chunk_index: chunkIndex,
    parent_chunk_index: chunkIndex === 0 ? null : 0,
    segment_level: chunkIndex === 0 ? "section" : "chunk",
    modality: "text",
    source_locator: { page: chunkIndex + 1 },
    tokens: 8,
    metadata: { source: "test" },
    score,
  };
}

const defaultConfig = {
  visualIndexEnabled: false,
  retrievalCandidateLimit: 40,
  retrievalRerankEnabled: false,
  retrievalRerankModelId: "cohere.rerank-v3-5:0",
  retrievalNeighborCount: 1,
  retrievalContextTokens: 4_000,
  retrievalRrfK: 60,
  retrievalMaxPerSource: 3,
};

describe("shared repository retrieval v2 service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockResolvedValue(defaultConfig);
    mockGetAccessibleRepositories.mockResolvedValue([
      { id: 7, isAccessible: true },
    ]);
    mockGetUser.mockResolvedValue({ id: 42 });
  });

  it("uses the active generation descriptor, fuses signals, and returns exact context citations", async () => {
    const generateTextEmbedding = jest.fn().mockResolvedValue([0.1, 0.2]);
    mockExecuteQuery
      .mockResolvedValueOnce([{ roleId: 5 }])
      .mockResolvedValueOnce([
        {
          repository_id: 7,
          repository_name: "District Policies",
          generation_id: generationId,
          embedding_model: "amazon-bedrock:amazon.titan-embed-text-v1",
          embedding_dimensions: 1536,
          visual_embedding_model: null,
          visual_embedding_dimensions: null,
        },
      ])
      .mockResolvedValueOnce([row(1, 0.9, 0)])
      .mockResolvedValueOnce([row(1, 0.7, 0), row(2, 0.6, 1)])
      .mockResolvedValueOnce([row(1, 0, 0)]);

    const response = await retrieveRepositoryContent(
      {
        query: "evacuation policy",
        repositoryIds: [7],
        userCognitoSub: "user-sub",
        limit: 1,
      },
      { generateTextEmbedding },
    );

    expect(generateTextEmbedding).toHaveBeenCalledWith("evacuation policy", {
      provider: "amazon-bedrock",
      modelId: "amazon.titan-embed-text-v1",
      dimensions: 1536,
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      generationId,
      itemVersionId,
      citations: [
        {
          itemVersionId,
          versionNumber: 4,
          chunkId: 1,
          label: "Page 1",
        },
      ],
      context: [{ chunkId: 1, content: "Policy content 1" }],
    });
    expect(response.diagnostics).toMatchObject({
      repositoriesAuthorized: 1,
      denseCandidates: 1,
      lexicalCandidates: 2,
      returnedResults: 1,
    });
  });

  it("does not resolve generations or candidates when repository ACL denies access", async () => {
    mockGetAccessibleRepositories.mockResolvedValue([
      { id: 7, isAccessible: false },
    ]);
    const response = await retrieveRepositoryContent({
      query: "private policy",
      repositoryIds: [7],
      userCognitoSub: "user-sub",
      mode: "keyword",
    });

    expect(response.results).toEqual([]);
    expect(response.diagnostics.repositoriesAuthorized).toBe(0);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("fails open to fused ranking when the managed reranker is unavailable", async () => {
    const reranker: RepositoryReranker = {
      rerank: jest.fn().mockRejectedValue(new Error("Bedrock throttled")),
    };
    mockGetConfig.mockResolvedValue({
      ...defaultConfig,
      retrievalRerankEnabled: true,
    });
    mockExecuteQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          repository_id: 7,
          repository_name: "District Policies",
          generation_id: generationId,
          embedding_model: "amazon-bedrock:amazon.titan-embed-text-v1",
          embedding_dimensions: 1536,
          visual_embedding_model: null,
          visual_embedding_dimensions: null,
        },
      ])
      .mockResolvedValueOnce([row(1, 0.8, 0), row(2, 0.7, 1)])
      .mockResolvedValueOnce([row(1, 0, 0)])
      .mockResolvedValueOnce([row(2, 0, 1)]);

    const response = await retrieveRepositoryContent(
      {
        query: "closure",
        repositoryIds: [7],
        userCognitoSub: "user-sub",
        mode: "keyword",
        limit: 2,
      },
      { reranker },
    );

    expect(response.results.map((result) => result.chunkId)).toEqual([1, 2]);
    expect(response.diagnostics.reranked).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      "Bedrock reranking unavailable; using reciprocal-rank fusion",
      { error: "Bedrock throttled" },
    );
  });

  it("never exceeds the tokenizer-counted context budget", async () => {
    mockExecuteQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          repository_id: 7,
          repository_name: "District Policies",
          generation_id: generationId,
          embedding_model: null,
          embedding_dimensions: null,
          visual_embedding_model: null,
          visual_embedding_dimensions: null,
        },
      ])
      .mockResolvedValueOnce([row(1, 0.8, 0)])
      .mockResolvedValueOnce([
        {
          ...row(1, 0, 0),
          context_prefix: "Detailed section context ".repeat(50),
          content: "Long policy text ".repeat(500),
        },
      ]);

    const response = await retrieveRepositoryContent({
      query: "policy",
      repositoryIds: [7],
      userCognitoSub: "user-sub",
      mode: "keyword",
      limit: 1,
      tokenBudget: 100,
    });

    expect(response.diagnostics.returnedTokens).toBeLessThanOrEqual(100);
    expect(response.results[0]?.context[0]?.content).toContain(
      "truncated to retrieval budget",
    );
  });

  it("retrieves image segments in the generation-pinned visual vector space", async () => {
    const generateVisualEmbedding = jest.fn().mockResolvedValue([0.3, 0.4]);
    mockGetConfig.mockResolvedValue({
      ...defaultConfig,
      visualIndexEnabled: true,
    });
    const imageRow = {
      ...row(5, 0.92, 4),
      modality: "image",
      context_prefix: "Campus evacuation map",
      source_locator: {
        regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      },
    };
    mockExecuteQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          repository_id: 7,
          repository_name: "District Policies",
          generation_id: generationId,
          embedding_model: null,
          embedding_dimensions: null,
          visual_embedding_model: "amazon-bedrock:cohere.embed-v4:0",
          visual_embedding_dimensions: 1536,
        },
      ])
      .mockResolvedValueOnce([imageRow])
      .mockResolvedValueOnce([imageRow]);

    const response = await retrieveRepositoryContent(
      {
        query: "show the evacuation map",
        repositoryIds: [7],
        userCognitoSub: "user-sub",
        mode: "vector",
        modalities: ["image"],
        limit: 1,
      },
      { generateVisualEmbedding },
    );

    expect(generateVisualEmbedding).toHaveBeenCalledWith(
      "show the evacuation map",
      "cohere.embed-v4:0",
      1536,
    );
    expect(response.results[0]).toMatchObject({
      modality: "image",
      visualScore: 0.92,
      citations: [{ label: "Image region" }],
    });
    expect(response.diagnostics.visualCandidates).toBe(1);
  });
});
