/** @jest-environment node */

import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createS3RepositoryMigrationStorage } from "@/lib/repositories/content-platform/migration-s3-storage";

describe("unified content migration S3 storage", () => {
  it("streams the source hash once and does not redownload a successful copy", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () =>
            new TextEncoder().encode("source bytes"),
        },
        ContentLength: 12,
        ContentType: "application/pdf",
      })
      .mockResolvedValueOnce({});
    const storage = createS3RepositoryMigrationStorage({
      bucket: "documents",
      client: { send } as unknown as S3Client,
    });

    await expect(
      storage.inspectAndCopyObject({
        sourceKey: "legacy/owner/file.pdf",
        targetKey: "repositories/1/id/file.pdf",
      }),
    ).resolves.toMatchObject({
      byteSize: 12,
      contentType: "application/pdf",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CopyObjectCommand);
  });

  it("reuses a deterministic target only when its bytes match", async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        }),
      )
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () =>
            new TextEncoder().encode("same bytes"),
        },
        ContentLength: 10,
        ContentType: "text/plain",
      });
    const storage = createS3RepositoryMigrationStorage({
      bucket: "documents",
      client: { send } as unknown as S3Client,
    });

    await expect(
      storage.putObject({
        targetKey: "repositories/1/id/source.txt",
        body: new TextEncoder().encode("same bytes"),
        contentType: "text/plain",
        metadata: {},
      }),
    ).resolves.toMatchObject({
      byteSize: 10,
      contentType: "text/plain",
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("rejects a deterministic target containing different bytes", async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("exists"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        }),
      )
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () =>
            new TextEncoder().encode("different"),
        },
        ContentLength: 9,
        ContentType: "text/plain",
      });
    const storage = createS3RepositoryMigrationStorage({
      bucket: "documents",
      client: { send } as unknown as S3Client,
    });
    await expect(
      storage.putObject({
        targetKey: "repositories/1/id/source.txt",
        body: new TextEncoder().encode("expected"),
        contentType: "text/plain",
        metadata: {},
      }),
    ).rejects.toThrow(
      "Deterministic migration target exists with different bytes",
    );
  });
});
