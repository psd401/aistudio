/** @jest-environment node */

const mockRetrieveRepositoryContent = jest.fn();
const mockProcessInput = jest.fn();

jest.mock("@/lib/repositories/retrieval-v2/service", () => ({
  retrieveRepositoryContent: (...args: unknown[]) =>
    mockRetrieveRepositoryContent(...args),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock("@/lib/safety", () => ({
  getContentSafetyService: () => ({
    processInput: (...args: unknown[]) => mockProcessInput(...args),
  }),
}));
jest.mock("ai", () => ({
  tool: (definition: unknown) => definition,
}));

import { createNexusAttachmentTools } from "@/lib/nexus/attachment-repository-tool";
import { createTokenMappingSink } from "@/lib/safety/token-mapping-sink";
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
      tokens: [],
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

  it("uses only validated bound repository IDs and preserves exact citations", async () => {
    const tools = createNexusAttachmentTools({
      repositoryIds: [7, 7, -1],
      userCognitoSub: "executing-user",
      tokenMappingSink: createTokenMappingSink(),
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;

    await expect(
      search.execute({ query: "attendance", limit: 3 })
    ).resolves.toEqual({
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

  it("tokenizes retrieved PII before returning a provider-visible tool result", async () => {
    const nameToken = {
      token: "11111111-1111-4111-8111-111111111111",
      original: "Avery Student",
      type: "NAME",
      placeholder: "[PII:11111111-1111-4111-8111-111111111111]",
    };
    const emailToken = {
      token: "22222222-2222-4222-8222-222222222222",
      original: "avery.student@example.edu",
      type: "EMAIL",
      placeholder: "[PII:22222222-2222-4222-8222-222222222222]",
    };
    mockRetrieveRepositoryContent.mockResolvedValueOnce({
      results: [
        {
          chunkId: 19,
          itemName: "Student record",
          content:
            "Avery Student can be reached at avery.student@example.edu.",
          similarity: 0.98,
          context: [],
          citations: [],
        },
      ],
    });
    mockProcessInput.mockResolvedValueOnce({
      allowed: true,
      processedContent:
        "[PII:11111111-1111-4111-8111-111111111111] can be reached at [PII:22222222-2222-4222-8222-222222222222].",
      contentModified: true,
      requestId: "safety-request",
      processingTimeMs: 1,
      tokens: [nameToken, emailToken],
    });
    const tokenMappingSink = createTokenMappingSink();
    const tools = createNexusAttachmentTools({
      repositoryIds: [7],
      userCognitoSub: "executing-user",
      tokenMappingSink,
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;

    const providerVisibleResult = await search.execute({
      query: "contact details",
    });
    const serializedResult = JSON.stringify(providerVisibleResult);

    expect(serializedResult).not.toContain("Avery Student");
    expect(serializedResult).not.toContain("avery.student@example.edu");
    expect(serializedResult).toContain(nameToken.placeholder);
    expect(serializedResult).toContain(emailToken.placeholder);
    expect(mockProcessInput).toHaveBeenCalledWith(
      "Avery Student can be reached at avery.student@example.edu.",
      "executing-user"
    );
    expect(tokenMappingSink.size).toBe(2);
    expect(tokenMappingSink.resolve(nameToken.placeholder)).toBe(
      nameToken.original
    );
    expect(tokenMappingSink.resolve(emailToken.placeholder)).toBe(
      emailToken.original
    );
  });

  it("fails closed without returning chunk bytes when retrieved content is blocked", async () => {
    mockProcessInput.mockResolvedValueOnce({
      allowed: false,
      processedContent: "",
      blockedMessage: "Retrieved content blocked",
      blockedCategories: ["PROHIBITED"],
      contentModified: false,
      requestId: "safety-request",
      processingTimeMs: 1,
    });
    const tools = createNexusAttachmentTools({
      repositoryIds: [7],
      userCognitoSub: "executing-user",
      tokenMappingSink: createTokenMappingSink(),
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;

    await expect(
      search.execute({ query: "attendance" })
    ).rejects.toBeInstanceOf(ContentSafetyBlockedError);
  });

  it("uses a generic fail-closed error when safety processing rejects", async () => {
    mockProcessInput.mockRejectedValueOnce(
      new Error("provider failed while handling secret source bytes")
    );
    const tools = createNexusAttachmentTools({
      repositoryIds: [7],
      userCognitoSub: "executing-user",
      tokenMappingSink: createTokenMappingSink(),
    });
    const search = tools.searchNexusAttachments as unknown as SearchTool;

    await expect(search.execute({ query: "attendance" })).rejects.toThrow(
      "Attachment search results could not be safety-checked"
    );
  });

  it("creates no tool without a valid server binding", () => {
    expect(
      createNexusAttachmentTools({
        repositoryIds: [],
        userCognitoSub: "user",
        tokenMappingSink: createTokenMappingSink(),
      })
    ).toEqual({});
  });
});
