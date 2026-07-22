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

  it("does not touch storage or the database for text and URL items", async () => {
    await expect(
      deleteRepositoryItemStorage({
        id: 42,
        repositoryId: 7,
        type: "text",
        source: "inline text",
      }, dependencies([]))
    ).resolves.toEqual({ sourceObjectCount: 0, artifactObjectCount: 0 });

    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockDeleteRepositoryObjectsByPrefix).not.toHaveBeenCalled();
  });
});
