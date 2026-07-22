/** @jest-environment node */

const mockRetrieve = jest.fn();
const mockAccessible = jest.fn();
const mockContentReadV2Active = jest.fn((_config: unknown) => true);
const mockKeywordSearch = jest.fn();

jest.mock("ai", () => ({ tool: (definition: unknown) => definition }));
jest.mock("@/lib/repositories/retrieval-v2/service", () => ({
  retrieveRepositoryContent: (...args: unknown[]) => mockRetrieve(...args),
}));
jest.mock("@/lib/repositories/content-platform/config", () => ({
  getContentPlatformConfig: jest.fn(async () => ({
    enabled: true,
    readV2Enabled: true,
  })),
  isContentReadV2Active: (config: unknown) =>
    mockContentReadV2Active(config),
}));
jest.mock("@/lib/repositories/search-service", () => ({
  vectorSearch: jest.fn(),
  keywordSearch: (...args: unknown[]) => mockKeywordSearch(...args),
  hybridSearch: jest.fn(),
}));
jest.mock("@/lib/db/drizzle", () => ({
  getAccessibleRepositoriesByCognitoSub: (...args: unknown[]) =>
    mockAccessible(...args),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { createKeywordSearchTool } from "@/lib/tools/repository-tools";

interface ExecutableTool {
  execute(input: { query: string; limit?: number }): Promise<unknown>;
}

describe("repository assistant tools use retrieval v2", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContentReadV2Active.mockReturnValue(true);
    mockAccessible.mockResolvedValue([{ id: 4, isAccessible: true }]);
    mockRetrieve.mockResolvedValue({
      results: [
        {
          content: "Emergency procedure",
          itemName: "Handbook",
          similarity: 0.8,
          chunkIndex: 2,
          citations: [{ itemVersionId: "version", label: "Page 3" }],
          context: [{ content: "Neighbor context" }],
        },
      ],
    });
  });

  it("revalidates executing-user access and returns versioned citations", async () => {
    const searchTool = createKeywordSearchTool({
      repositoryIds: [4, 5],
      userCognitoSub: "executing-user",
      assistantOwnerSub: "different-owner",
    }) as ExecutableTool;
    const result = await searchTool.execute({ query: "emergency", limit: 3 });

    expect(mockAccessible).toHaveBeenCalledWith([4, 5], "executing-user");
    expect(mockRetrieve).toHaveBeenCalledWith({
      query: "emergency",
      repositoryIds: [4],
      userCognitoSub: "executing-user",
      mode: "keyword",
      limit: 3,
    });
    expect(result).toMatchObject({
      success: true,
      results: [{ citation: { itemVersionId: "version", label: "Page 3" } }],
    });
  });

  it("does not invoke retrieval when no requested repository is accessible", async () => {
    mockAccessible.mockResolvedValue([{ id: 4, isAccessible: false }]);
    const searchTool = createKeywordSearchTool({
      repositoryIds: [4],
      userCognitoSub: "executing-user",
    }) as ExecutableTool;

    await expect(searchTool.execute({ query: "private" })).resolves.toMatchObject({
      success: false,
      error: "No access to specified repositories",
    });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("uses the legacy search path when retrieval v2 is disabled", async () => {
    mockContentReadV2Active.mockReturnValue(false);
    mockKeywordSearch.mockResolvedValue([
      {
        content: "Legacy emergency procedure",
        itemName: "Handbook",
        similarity: 0.75,
        chunkIndex: 4,
      },
    ]);
    const searchTool = createKeywordSearchTool({
      repositoryIds: [4],
      userCognitoSub: "executing-user",
      assistantOwnerSub: "different-owner",
    }) as ExecutableTool;

    await expect(
      searchTool.execute({ query: "emergency", limit: 3 })
    ).resolves.toMatchObject({
      success: true,
      results: [{ content: "Legacy emergency procedure" }],
    });
    expect(mockKeywordSearch).toHaveBeenCalledWith("emergency", {
      repositoryId: 4,
      limit: 3,
    });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockAccessible).toHaveBeenCalledWith([4], "executing-user");
  });
});
