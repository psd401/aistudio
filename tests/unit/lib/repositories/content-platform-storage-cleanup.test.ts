/** @jest-environment node */

import { jest } from "@jest/globals";

interface StoredVersion {
  id: string;
  objectKey: string | null;
}

const mockDeleteDocument = jest.fn<(key: string) => Promise<void>>();
const mockDeleteRepositoryObjectsByPrefix = jest.fn<
  (prefix: string) => Promise<number>
>();

import { deleteRepositoryItemStorage } from "@/lib/repositories/content-platform/storage-cleanup";

describe("canonical repository storage cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteDocument.mockResolvedValue(undefined);
    mockDeleteRepositoryObjectsByPrefix.mockResolvedValue(0);
  });

  function dependencies(versions: StoredVersion[]) {
    return {
      getVersions: jest.fn(async () => versions),
      deleteObject: mockDeleteDocument,
      deletePrefix: mockDeleteRepositoryObjectsByPrefix,
    };
  }

  it("deletes image sources and every version artifact namespace", async () => {
    const cleanupDependencies = dependencies([
      {
        id: "11111111-2222-4333-8444-555555555555",
        objectKey: "repositories/7/upload/source.png",
      },
      {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        objectKey: "repositories/7/upload/source-v2.png",
      },
    ]);
    mockDeleteRepositoryObjectsByPrefix
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);

    await expect(
      deleteRepositoryItemStorage({
        id: 41,
        repositoryId: 7,
        type: "image",
        source: "repositories/7/upload/source.png",
      }, cleanupDependencies)
    ).resolves.toEqual({ sourceObjectCount: 2, artifactObjectCount: 5 });

    expect(mockDeleteDocument).toHaveBeenCalledTimes(2);
    expect(mockDeleteDocument).toHaveBeenCalledWith(
      "repositories/7/upload/source.png"
    );
    expect(mockDeleteDocument).toHaveBeenCalledWith(
      "repositories/7/upload/source-v2.png"
    );
    expect(mockDeleteRepositoryObjectsByPrefix).toHaveBeenCalledWith(
      "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/"
    );
    expect(mockDeleteRepositoryObjectsByPrefix).toHaveBeenCalledWith(
      "repositories/7/artifacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/"
    );
  });

  it("deletes canonical inline-text source objects without treating raw text as a key", async () => {
    const cleanupDependencies = dependencies([
      {
        id: "11111111-2222-4333-8444-555555555555",
        objectKey:
          "repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/inline.md",
      },
    ]);
    mockDeleteRepositoryObjectsByPrefix.mockResolvedValueOnce(2);

    await expect(
      deleteRepositoryItemStorage({
        id: 42,
        repositoryId: 7,
        type: "text",
        source: "inline text",
      }, cleanupDependencies)
    ).resolves.toEqual({ sourceObjectCount: 1, artifactObjectCount: 2 });

    expect(mockDeleteDocument).toHaveBeenCalledTimes(1);
    expect(mockDeleteDocument).toHaveBeenCalledWith(
      "repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/inline.md"
    );
    expect(mockDeleteDocument).not.toHaveBeenCalledWith("inline text");
    expect(mockDeleteRepositoryObjectsByPrefix).toHaveBeenCalledWith(
      "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/"
    );
  });

  it.each(["audio", "video"])(
    "deletes %s sources and BDA artifact namespaces",
    async (type) => {
      const cleanupDependencies = dependencies([
        {
          id: "11111111-2222-4333-8444-555555555555",
          objectKey:
            `repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source.${type}`,
        },
      ]);
      mockDeleteRepositoryObjectsByPrefix.mockResolvedValueOnce(4);

      await expect(
        deleteRepositoryItemStorage(
          {
            id: 43,
            repositoryId: 7,
            type,
            source:
              `repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source.${type}`,
          },
          cleanupDependencies
        )
      ).resolves.toEqual({ sourceObjectCount: 1, artifactObjectCount: 4 });

      expect(mockDeleteDocument).toHaveBeenCalledWith(
        `repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source.${type}`
      );
      expect(mockDeleteRepositoryObjectsByPrefix).toHaveBeenCalledWith(
        "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/"
      );
    }
  );

  it("does not treat URL or legacy inline text sources as object keys", async () => {
    const textDependencies = dependencies([]);
    await expect(
      deleteRepositoryItemStorage(
        {
          id: 44,
          repositoryId: 7,
          type: "text",
          source: "legacy inline text",
        },
        textDependencies
      )
    ).resolves.toEqual({ sourceObjectCount: 0, artifactObjectCount: 0 });

    const urlDependencies = dependencies([]);
    await expect(
      deleteRepositoryItemStorage(
        {
          id: 45,
          repositoryId: 7,
          type: "url",
          source: "https://example.edu/policy",
        },
        urlDependencies
      )
    ).resolves.toEqual({ sourceObjectCount: 0, artifactObjectCount: 0 });

    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockDeleteRepositoryObjectsByPrefix).not.toHaveBeenCalled();
    expect(textDependencies.getVersions).toHaveBeenCalledWith(44);
    expect(urlDependencies.getVersions).toHaveBeenCalledWith(45);
  });
});
