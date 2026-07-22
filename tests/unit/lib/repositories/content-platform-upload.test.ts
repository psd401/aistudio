/** @jest-environment node */

import { jest } from "@jest/globals";
import { executeQuery } from "@/lib/db/drizzle-client";
import { DEFAULT_CONTENT_PLATFORM_CONFIG } from "@/lib/repositories/content-platform/config";
import {
  initiateRepositoryUpload,
  type RepositoryUploadStorage,
} from "@/lib/repositories/content-platform/upload-service";

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: jest.fn(),
}));

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>;

function createStorage(): RepositoryUploadStorage & {
  requestedPartCount: number;
} {
  const storage: RepositoryUploadStorage & { requestedPartCount: number } = {
    requestedPartCount: 0,
    createSingleUpload: jest.fn<RepositoryUploadStorage["createSingleUpload"]>(
      async () => ({ uploadUrl: "https://upload/single" })
    ),
    createMultipartUpload: jest.fn<
      RepositoryUploadStorage["createMultipartUpload"]
    >(async (input) => {
      storage.requestedPartCount = input.partCount;
      return {
        uploadId: "multipart-id",
        partUrls: Array.from({ length: input.partCount }, (_, index) => ({
          partNumber: index + 1,
          uploadUrl: `https://upload/part/${index + 1}`,
        })),
      };
    }),
    completeMultipartUpload: jest.fn<
      RepositoryUploadStorage["completeMultipartUpload"]
    >(async () => undefined),
    abortMultipartUpload: jest.fn<
      RepositoryUploadStorage["abortMultipartUpload"]
    >(async () => undefined),
    headObject: jest.fn<RepositoryUploadStorage["headObject"]>(async () => ({
      byteSize: 1,
      contentType: "application/pdf",
    })),
  };
  return storage;
}

const baseInput = {
  repositoryId: 7,
  userId: 11,
  itemName: "Emergency handbook",
  fileName: "Emergency handbook.pdf",
  contentType: "application/pdf",
  byteSize: 1024,
} as const;

describe("canonical repository upload initiation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteQuery.mockResolvedValue([]);
  });

  it("creates a repository-bound single upload session", async () => {
    const storage = createStorage();

    const result = await initiateRepositoryUpload(
      baseInput,
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    );

    expect(result.uploadMethod).toBe("single");
    expect(result.objectKey).toMatch(
      /^repositories\/7\/[0-9a-f-]{36}\/Emergency_handbook\.pdf$/
    );
    expect(storage.createSingleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "application/pdf" })
    );
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });

  it("bounds the maximum 500 MiB PDF to at most 100 signed parts", async () => {
    const storage = createStorage();

    const result = await initiateRepositoryUpload(
      { ...baseInput, byteSize: 500 * 1024 ** 2 },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    );

    expect(result.uploadMethod).toBe("multipart");
    expect(storage.requestedPartCount).toBeLessThanOrEqual(100);
    expect(result.partUrls).toHaveLength(storage.requestedPartCount);
    expect(result.partSize).toBeGreaterThanOrEqual(5 * 1024 ** 2);
  });

  it("aborts S3 multipart state when session persistence fails", async () => {
    const storage = createStorage();
    mockExecuteQuery.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      initiateRepositoryUpload(
        { ...baseInput, byteSize: 11 * 1024 ** 2 },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("database unavailable");

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: "multipart-id" })
    );
  });

  it("rejects unsupported content and administrator size violations before S3", async () => {
    const storage = createStorage();

    await expect(
      initiateRepositoryUpload(
        { ...baseInput, contentType: "application/zip" },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("PDF, Office, text, image, audio, and video files only");
    await expect(
      initiateRepositoryUpload(
        { ...baseInput, byteSize: 500 * 1024 ** 2 + 1 },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("500 MiB");
    expect(storage.createSingleUpload).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("accepts UTF-8 text formats using the bounded in-memory processor limit", async () => {
    const storage = createStorage();

    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          itemName: "Quick reference",
          fileName: "quick-reference.txt",
          contentType: "text/plain",
          byteSize: 1024,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).resolves.toMatchObject({ uploadMethod: "single" });
    expect(storage.createSingleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "text/plain" })
    );
    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          fileName: "oversized.csv",
          contentType: "text/csv",
          byteSize: 100 * 1024 ** 2 + 1,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("100 MiB");
  });

  it("accepts Office documents and enforces their independent size limit", async () => {
    const storage = createStorage();
    const contentType =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    const result = await initiateRepositoryUpload(
      {
        ...baseInput,
        fileName: "handbook.docx",
        contentType,
        byteSize: 5 * 1024 ** 2,
      },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    );

    expect(result.uploadMethod).toBe("single");
    expect(storage.createSingleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType })
    );
    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          fileName: "oversized.docx",
          contentType,
          byteSize: 100 * 1024 ** 2 + 1,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("100 MiB");
  });

  it("accepts images and enforces their independent size limit", async () => {
    const storage = createStorage();
    const result = await initiateRepositoryUpload(
      {
        ...baseInput,
        itemName: "Evacuation map",
        fileName: "evacuation-map.png",
        contentType: "image/png",
        byteSize: 5 * 1024 ** 2,
      },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    );

    expect(result.uploadMethod).toBe("single");
    expect(storage.createSingleUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/png" })
    );
    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          itemName: "Oversized image",
          fileName: "oversized.png",
          contentType: "image/png",
          byteSize: 50 * 1024 ** 2 + 1,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("50 MiB");
  });

  it("accepts audio and video while enforcing BDA byte ceilings", async () => {
    const storage = createStorage();

    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          itemName: "Board meeting audio",
          fileName: "board-meeting.mp3",
          contentType: "audio/mpeg",
          byteSize: 11 * 1024 ** 2,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).resolves.toMatchObject({ uploadMethod: "multipart" });
    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          itemName: "Training video",
          fileName: "training.mp4",
          contentType: "video/mp4",
          byteSize: 11 * 1024 ** 2,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).resolves.toMatchObject({ uploadMethod: "multipart" });
    await expect(
      initiateRepositoryUpload(
        {
          ...baseInput,
          itemName: "Oversized audio",
          fileName: "oversized.wav",
          contentType: "audio/wav",
          byteSize: 2 * 1024 ** 3 + 1,
        },
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toThrow("2048 MiB");
  });
});
