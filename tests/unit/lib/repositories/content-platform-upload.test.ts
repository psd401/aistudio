/** @jest-environment node */

import { jest } from "@jest/globals";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DEFAULT_CONTENT_PLATFORM_CONFIG } from "@/lib/repositories/content-platform/config";
import {
  initiateRepositoryUpload,
  MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER,
  RepositoryUploadQuotaExceededError,
  type RepositoryUploadStorage,
} from "@/lib/repositories/content-platform/upload-service";

jest.mock("@/lib/db/drizzle-client", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/db/drizzle-client")
  >("@/lib/db/drizzle-client");
  return {
    ...actual,
    executeQuery: jest.fn(),
    executeTransaction: jest.fn(),
  };
});

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>;
const mockExecuteTransaction = executeTransaction as unknown as jest.Mock;
void toPgRows;
const dialect = new PgDialect();

interface QuotaUsageRow {
  active_upload_count: number;
  active_upload_bytes: number;
  ephemeral_storage_bytes: number;
  ephemeral_storage_repository_count: number;
  target_has_ephemeral_storage: boolean;
}

const emptyUsage: QuotaUsageRow = {
  active_upload_count: 0,
  active_upload_bytes: 0,
  ephemeral_storage_bytes: 0,
  ephemeral_storage_repository_count: 0,
  target_has_ephemeral_storage: false,
};

function installReservation(options: {
  nexusManaged?: boolean;
  ownerId?: number;
  repositoryKind?: "durable" | "ephemeral" | "system";
  usage?: Partial<QuotaUsageRow>;
} = {}): void {
  mockExecuteTransaction.mockImplementation(
    async (callback: unknown) => {
      const execute = jest
        .fn<(query: unknown) => Promise<unknown>>()
        .mockResolvedValueOnce([
          {
            id: 7,
            nexus_managed: options.nexusManaged ?? false,
            owner_id: options.ownerId ?? baseInput.userId,
            repository_kind: options.repositoryKind ?? "durable",
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ...emptyUsage, ...options.usage }])
        .mockResolvedValueOnce([{ id: "reserved-session" }]);
      return (
        callback as (tx: { execute: typeof execute }) => Promise<unknown>
      )({ execute });
    }
  );
}

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
    mockExecuteQuery.mockResolvedValue([{ id: "activated-session" }]);
    installReservation();
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
      expect.objectContaining({
        contentType: "application/pdf",
        byteSize: 1024,
        metadata: {
          repositoryId: "7",
          uploadSessionId: expect.any(String),
        },
      })
    );
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps Unicode original names in the database instead of S3 headers", async () => {
    const storage = createStorage();

    await initiateRepositoryUpload(
      { ...baseInput, fileName: "Plan 🗺️.pdf" },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    );

    expect(storage.createSingleUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ originalFileName: expect.anything() }),
      })
    );
  });

  it("allows an authorized administrator to reserve in another owner's durable repository", async () => {
    const storage = createStorage();
    installReservation({ ownerId: 99, repositoryKind: "durable" });

    await expect(
      initiateRepositoryUpload(
        baseInput,
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).resolves.toMatchObject({ uploadMethod: "single" });
    expect(storage.createSingleUpload).toHaveBeenCalledTimes(1);
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
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });

  it("rejects an exhausted active-upload quota before allocating S3 state", async () => {
    const storage = createStorage();
    installReservation({
      usage: { active_upload_count: 10 },
    });

    const result = initiateRepositoryUpload(
      baseInput,
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    );
    await expect(result).rejects.toBeInstanceOf(
      RepositoryUploadQuotaExceededError
    );
    await expect(result).rejects.toMatchObject({
      code: "REPOSITORY_UPLOAD_QUOTA_EXCEEDED",
      httpStatus: 429,
      quota: "active-session-count",
    });

    expect(storage.createSingleUpload).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("serializes concurrent ephemeral reservations and counts completed current storage", async () => {
    const storage = createStorage();
    let storedBytes = MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER - baseInput.byteSize;
    let transactionTail = Promise.resolve();

    mockExecuteTransaction.mockImplementation(
      async (callback: unknown) => {
        let release: (() => void) | undefined;
        const predecessor = transactionTail;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await predecessor;
        try {
          let queryIndex = 0;
          const execute = jest.fn(async (query: unknown) => {
            const sqlText = dialect.sqlToQuery(query as SQL).sql;
            const currentQuery = queryIndex;
            queryIndex += 1;
            if (currentQuery === 0) {
              expect(sqlText).toContain("FOR UPDATE OF repository");
              return [
                {
                  id: 7,
                  nexus_managed: true,
                  owner_id: baseInput.userId,
                  repository_kind: "ephemeral",
                },
              ];
            }
            if (currentQuery === 1) {
              expect(sqlText).toContain("pg_advisory_xact_lock");
              return [];
            }
            if (currentQuery === 2) {
              expect(sqlText).toContain("active_upload_count");
              return [
                {
                  ...emptyUsage,
                  ephemeral_storage_bytes: storedBytes,
                  ephemeral_storage_repository_count: 1,
                  target_has_ephemeral_storage: true,
                },
              ];
            }
            if (currentQuery === 3) {
              expect(sqlText).toContain(
                "INSERT INTO repository_upload_sessions"
              );
              storedBytes += baseInput.byteSize;
              return [{ id: "reserved-session" }];
            }
            throw new Error(`Unexpected reservation query: ${sqlText}`);
          });
          return await (
            callback as (tx: { execute: typeof execute }) => Promise<unknown>
          )({ execute });
        } finally {
          release?.();
        }
      }
    );

    const outcomes = await Promise.allSettled([
      initiateRepositoryUpload(
        baseInput,
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      ),
      initiateRepositoryUpload(
        baseInput,
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled"))
      .toHaveLength(1);
    const [rejected] = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected"
    );
    expect(rejected?.reason).toMatchObject({
      name: "RepositoryUploadQuotaExceededError",
      quota: "ephemeral-storage-bytes",
      httpStatus: 429,
    });
    expect(storage.createSingleUpload).toHaveBeenCalledTimes(1);
  });

  it("rejects an owner with more than 100 active ephemeral repositories, including empty bindings", async () => {
    const storage = createStorage();
    installReservation({
      repositoryKind: "ephemeral",
      usage: {
        ephemeral_storage_repository_count: 101,
        target_has_ephemeral_storage: true,
      },
    });

    await expect(
      initiateRepositoryUpload(
        baseInput,
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toMatchObject({
      name: "RepositoryUploadQuotaExceededError",
      quota: "ephemeral-repository-count",
      httpStatus: 429,
    });
    expect(storage.createSingleUpload).not.toHaveBeenCalled();
  });

  it("keeps promoted Nexus-managed durable repositories inside the owner quota", async () => {
    const storage = createStorage();
    installReservation({
      repositoryKind: "durable",
      nexusManaged: true,
      usage: {
        ephemeral_storage_bytes:
          MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER,
        ephemeral_storage_repository_count: 4,
        target_has_ephemeral_storage: true,
      },
    });

    await expect(
      initiateRepositoryUpload(
        baseInput,
        DEFAULT_CONTENT_PLATFORM_CONFIG,
        storage
      )
    ).rejects.toMatchObject({
      name: "RepositoryUploadQuotaExceededError",
      quota: "ephemeral-storage-bytes",
    });
    expect(storage.createSingleUpload).not.toHaveBeenCalled();
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
