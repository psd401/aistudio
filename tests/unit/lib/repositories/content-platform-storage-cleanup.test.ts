/** @jest-environment node */

import { jest } from "@jest/globals";

interface StoredVersion {
  id: string;
  objectKey: string | null;
}

const mockDeleteObjectVersions = jest.fn<(key: string) => Promise<number>>();
const mockDeleteLegacyObject = jest.fn<(key: string) => Promise<void>>();
const mockDeleteRepositoryObjectVersionsByPrefix = jest.fn<
  (prefix: string) => Promise<number>
>();

import {
  deleteRepositoryItemStorage,
  deleteRepositoryStorageTree,
} from "@/lib/repositories/content-platform/storage-cleanup";

describe("canonical repository storage cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteObjectVersions.mockResolvedValue(0);
    mockDeleteLegacyObject.mockResolvedValue(undefined);
    mockDeleteRepositoryObjectVersionsByPrefix.mockResolvedValue(0);
  });

  function dependencies(versions: StoredVersion[]) {
    return {
      getVersions: jest.fn(async () => versions),
      deleteObjectVersions: mockDeleteObjectVersions,
      deleteLegacyObject: mockDeleteLegacyObject,
      deletePrefixVersions: mockDeleteRepositoryObjectVersionsByPrefix,
    };
  }

  it("deletes image sources and every version artifact namespace", async () => {
    const cleanupDependencies = dependencies([
      {
        id: "11111111-2222-4333-8444-555555555555",
        objectKey:
          "repositories/7/11111111-2222-4333-8444-555555555555/source.png",
      },
      {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        objectKey:
          "repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source-v2.png",
      },
    ]);
    mockDeleteRepositoryObjectVersionsByPrefix
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);

    await expect(
      deleteRepositoryItemStorage({
        id: 41,
        repositoryId: 7,
        type: "image",
        source:
          "repositories/7/11111111-2222-4333-8444-555555555555/source.png",
      }, cleanupDependencies)
    ).resolves.toEqual({ sourceObjectCount: 2, artifactObjectCount: 5 });

    expect(mockDeleteObjectVersions).toHaveBeenCalledTimes(2);
    expect(mockDeleteObjectVersions).toHaveBeenCalledWith(
      "repositories/7/11111111-2222-4333-8444-555555555555/source.png"
    );
    expect(mockDeleteObjectVersions).toHaveBeenCalledWith(
      "repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source-v2.png"
    );
    expect(mockDeleteLegacyObject).not.toHaveBeenCalled();
    expect(mockDeleteRepositoryObjectVersionsByPrefix).toHaveBeenCalledWith(
      "repositories/7/artifacts/11111111-2222-4333-8444-555555555555/"
    );
    expect(mockDeleteRepositoryObjectVersionsByPrefix).toHaveBeenCalledWith(
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
    mockDeleteRepositoryObjectVersionsByPrefix.mockResolvedValueOnce(2);

    await expect(
      deleteRepositoryItemStorage({
        id: 42,
        repositoryId: 7,
        type: "text",
        source: "inline text",
      }, cleanupDependencies)
    ).resolves.toEqual({ sourceObjectCount: 1, artifactObjectCount: 2 });

    expect(mockDeleteObjectVersions).toHaveBeenCalledTimes(1);
    expect(mockDeleteObjectVersions).toHaveBeenCalledWith(
      "repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/inline.md"
    );
    expect(mockDeleteObjectVersions).not.toHaveBeenCalledWith("inline text");
    expect(mockDeleteRepositoryObjectVersionsByPrefix).toHaveBeenCalledWith(
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
      mockDeleteRepositoryObjectVersionsByPrefix.mockResolvedValueOnce(4);

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

      expect(mockDeleteObjectVersions).toHaveBeenCalledWith(
        `repositories/7/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/source.${type}`
      );
      expect(mockDeleteRepositoryObjectVersionsByPrefix).toHaveBeenCalledWith(
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

    expect(mockDeleteObjectVersions).not.toHaveBeenCalled();
    expect(mockDeleteRepositoryObjectVersionsByPrefix).not.toHaveBeenCalled();
    expect(textDependencies.getVersions).toHaveBeenCalledWith(44);
    expect(urlDependencies.getVersions).toHaveBeenCalledWith(45);
  });

  it("retains the legacy DeleteObject path for historical file keys", async () => {
    const cleanupDependencies = dependencies([
      {
        id: "11111111-2222-4333-8444-555555555555",
        objectKey: null,
      },
    ]);

    await expect(
      deleteRepositoryItemStorage(
        {
          id: 46,
          repositoryId: 7,
          type: "document",
          source: "42/1700000000-historical-policy.pdf",
        },
        cleanupDependencies
      )
    ).resolves.toEqual({ sourceObjectCount: 1, artifactObjectCount: 0 });

    expect(mockDeleteLegacyObject).toHaveBeenCalledWith(
      "42/1700000000-historical-policy.pdf"
    );
    expect(mockDeleteObjectVersions).not.toHaveBeenCalled();
  });

  it("propagates legacy storage failures so manifests remain retryable", async () => {
    const cleanupDependencies = dependencies([]);
    mockDeleteLegacyObject.mockRejectedValueOnce(
      new Error("legacy storage unavailable")
    );

    await expect(
      deleteRepositoryItemStorage(
        {
          id: 48,
          repositoryId: 7,
          type: "document",
          source: "42/1700000000-historical-policy.pdf",
        },
        cleanupDependencies
      )
    ).rejects.toThrow("legacy storage unavailable");

    expect(mockDeleteRepositoryObjectVersionsByPrefix).not.toHaveBeenCalled();
  });

  it("fails closed for a canonical-looking key owned by another repository", async () => {
    const cleanupDependencies = dependencies([]);

    await expect(
      deleteRepositoryItemStorage(
        {
          id: 47,
          repositoryId: 7,
          type: "document",
          source:
            "repositories/8/11111111-2222-4333-8444-555555555555/other.pdf",
        },
        cleanupDependencies
      )
    ).rejects.toThrow("outside its cleanup scope");

    expect(mockDeleteLegacyObject).not.toHaveBeenCalled();
    expect(mockDeleteObjectVersions).not.toHaveBeenCalled();
    expect(mockDeleteRepositoryObjectVersionsByPrefix).not.toHaveBeenCalled();
  });

  it("cleans every item type before sweeping the complete repository prefix", async () => {
    const items = ["text", "document", "image", "audio", "video"].map(
      (type, index) => ({
        id: index + 1,
        repositoryId: 7,
        type,
        source: `source-${index + 1}`,
      })
    );
    const deleteItemStorage = jest.fn(
      async () => ({ sourceObjectCount: 1, artifactObjectCount: 2 })
    );
    const deletePrefixVersions = jest.fn(async () => 11);

    await expect(
      deleteRepositoryStorageTree(7, items, {
        deleteItemStorage,
        deletePrefixVersions,
      })
    ).resolves.toEqual({
      itemCount: 5,
      sourceObjectCount: 5,
      artifactObjectCount: 10,
      repositoryObjectCount: 11,
    });

    expect(deleteItemStorage).toHaveBeenCalledTimes(5);
    for (const item of items) {
      expect(deleteItemStorage).toHaveBeenCalledWith(item);
    }
    expect(deletePrefixVersions).toHaveBeenCalledWith("repositories/7/");
    expect(deleteItemStorage.mock.invocationCallOrder.at(-1)).toBeLessThan(
      deletePrefixVersions.mock.invocationCallOrder[0]!
    );
  });

  it("does not sweep or permit manifest deletion after item cleanup fails", async () => {
    const deleteItemStorage = jest.fn(
      async (): Promise<{
        sourceObjectCount: number;
        artifactObjectCount: number;
      }> => {
        throw new Error("storage unavailable");
      }
    );
    const deletePrefixVersions = jest.fn(async () => 0);

    await expect(
      deleteRepositoryStorageTree(
        7,
        [
          {
            id: 1,
            repositoryId: 7,
            type: "document",
            source: "repositories/7/source/document.pdf",
          },
        ],
        { deleteItemStorage, deletePrefixVersions }
      )
    ).rejects.toThrow("storage unavailable");

    expect(deletePrefixVersions).not.toHaveBeenCalled();
  });

  it("rejects a mismatched item scope before touching storage", async () => {
    const deleteItemStorage = jest.fn(
      async () => ({ sourceObjectCount: 0, artifactObjectCount: 0 })
    );
    const deletePrefixVersions = jest.fn(async () => 0);

    await expect(
      deleteRepositoryStorageTree(
        7,
        [{ id: 1, repositoryId: 8, type: "text", source: "inline" }],
        { deleteItemStorage, deletePrefixVersions }
      )
    ).rejects.toThrow("Invalid repository storage cleanup scope");

    expect(deleteItemStorage).not.toHaveBeenCalled();
    expect(deletePrefixVersions).not.toHaveBeenCalled();
  });
});
