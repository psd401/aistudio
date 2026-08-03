/** @jest-environment node */

const mockRetrieveRepositoryContent = jest.fn();
const mockProcessInput = jest.fn();

jest.mock("@/lib/repositories/retrieval-v2/service", () => ({
  retrieveRepositoryContent: (...args: unknown[]) =>
    mockRetrieveRepositoryContent(...args),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock("@/lib/safety", () => ({
  getContentSafetyService: () => ({
    processInput: (...args: unknown[]) => mockProcessInput(...args),
  }),
}));
jest.mock("ai", () => ({ tool: (definition: unknown) => definition }));

import {
  createNexusAttachmentTools,
  createNexusRepositorySearchTools,
} from "@/lib/nexus/attachment-repository-tool";
import { ContentSafetyBlockedError } from "@/lib/streaming/types";

interface SearchTool {
  execute(input: { query: string; limit?: number }): Promise<unknown>;
}

describe("Nexus attachment repository tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessInput.mockImplementation(async (content: unknown) => ({
      allowed: true,
      processedContent: String(content),
      contentModified: false,
      requestId: "safety-request",
      processingTimeMs: 1,
    }));
    mockRetrieveRepositoryContent.mockResolvedValue({
      results: [
        {
          chunkId: 12,
          itemName: "Student handbook",
          content: "Unbounded source",
          similarity: 0.91,
          context: [{ chunkId: 12, content: "Budgeted source" }],
          citations: [
            {
              itemVersionId: "version-1",
              chunkId: 12,
              label: "Page 4",
              sourceLocator: { page: 4 },
            },
          ],
        },
      ],
    });
  });

  it("uses only validated bindings and preserves exact citations", async () => {
    const tools = createNexusAttachmentTools({
      repositoryIds: [7, 7, -1],
      userCognitoSub: "executing-user",
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;

    await expect(search.execute({ query: "attendance", limit: 3 })).resolves.toEqual({
      success: true,
      query: "attendance",
      results: [
        {
          content: "Budgeted source",
          source: "Student handbook",
          score: 0.91,
          citations: [
            {
              itemVersionId: "version-1",
              chunkId: 12,
              label: "Page 4",
              sourceLocator: { page: 4 },
            },
          ],
        },
      ],
    });
    expect(mockRetrieveRepositoryContent).toHaveBeenCalledWith({
      query: "attendance",
      repositoryIds: [7],
      userCognitoSub: "executing-user",
      mode: "hybrid",
      limit: 3,
    });
  });

  it("returns allowed PII-containing retrieval text byte-identical", async () => {
    const content = "Avery Student can be reached at avery.student@example.edu.";
    mockRetrieveRepositoryContent.mockResolvedValueOnce({
      results: [{
        chunkId: 19,
        itemName: "Student record",
        content,
        similarity: 0.98,
        context: [],
        citations: [],
      }],
    });
    const tools = createNexusAttachmentTools({
      repositoryIds: [7],
      userCognitoSub: "executing-user",
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;

    await expect(search.execute({ query: "contact details" })).resolves.toMatchObject({
      results: [{ content }],
    });
    expect(mockProcessInput).toHaveBeenCalledWith(content, "executing-user");
  });

  it("supports server-named repository tools with the same guardrail boundary", async () => {
    const tools = createNexusRepositorySearchTools({
      repositoryIds: [7],
      userCognitoSub: "executing-user",
      toolName: "searchProjectRepositories",
      description: "Search project repositories",
    });
    const search = tools.searchProjectRepositories as unknown as SearchTool;
    await expect(search.execute({ query: "attendance" })).resolves.toMatchObject({
      success: true,
      results: [{ content: "Budgeted source" }],
    });
  });

  it("fails closed when retrieved content is blocked or cannot be checked", async () => {
    const tools = createNexusAttachmentTools({
      repositoryIds: [7],
      userCognitoSub: "executing-user",
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;
    mockProcessInput.mockResolvedValueOnce({
      allowed: false,
      processedContent: "",
      blockedMessage: "Retrieved content blocked",
      blockedCategories: ["PROHIBITED"],
    });
    await expect(search.execute({ query: "attendance" })).rejects.toBeInstanceOf(
      ContentSafetyBlockedError,
    );

    mockProcessInput.mockRejectedValueOnce(new Error("guardrail unavailable"));
    await expect(search.execute({ query: "attendance" })).rejects.toThrow(
      "Attachment search results could not be safety-checked",
    );
  });

  it("creates no tool without a valid server binding", () => {
    expect(
      createNexusAttachmentTools({ repositoryIds: [], userCognitoSub: "user" }),
    ).toEqual({});
  });
});
