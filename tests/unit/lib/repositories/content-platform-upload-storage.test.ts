/** @jest-environment node */

import { jest } from "@jest/globals";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createRepositoryUploadStorage } from "@/lib/repositories/content-platform/upload-service";

type SignUrl = typeof import("@aws-sdk/s3-request-presigner").getSignedUrl;

describe("repository upload presigning", () => {
  const send = jest.fn<(command: unknown) => Promise<unknown>>();
  const signUrl = jest.fn(async () => "https://upload.example");
  const client = { send } as unknown as S3Client;

  beforeEach(() => {
    send.mockReset();
    signUrl.mockClear();
    send.mockImplementation((command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "upload-1" });
      }
      return Promise.resolve({});
    });
  });

  it("binds a single-upload signature to the declared content length", async () => {
    const storage = await createRepositoryUploadStorage({
      config: { bucket: "test-bucket", region: "us-east-1" },
      client,
      signUrl: signUrl as unknown as SignUrl,
    });

    await storage.createSingleUpload({
      objectKey:
        "repositories/7/11111111-2222-4333-8444-555555555555/source.pdf",
      contentType: "application/pdf",
      byteSize: 1_024,
      metadata: { repositoryId: "7" },
    });

    expect(signUrl).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-bucket",
          ContentLength: 1_024,
          IfNoneMatch: "*",
          Tagging: "aistudio-upload-state=temporary",
        }),
      }),
      expect.any(Object)
    );
  });

  it("binds every multipart signature to its exact expected part length", async () => {
    const storage = await createRepositoryUploadStorage({
      config: { bucket: "test-bucket", region: "us-east-1" },
      client,
      signUrl: signUrl as unknown as SignUrl,
    });
    const mebibyte = 1024 ** 2;

    await storage.createMultipartUpload({
      objectKey:
        "repositories/7/11111111-2222-4333-8444-555555555555/source.pdf",
      contentType: "application/pdf",
      byteSize: 11 * mebibyte,
      partSize: 5 * mebibyte,
      partCount: 3,
      metadata: { repositoryId: "7" },
    });

    const signedParts = (
      signUrl.mock.calls as unknown as Array<
        [S3Client, unknown, { expiresIn: number }]
      >
    )
      .map((call) => call[1])
      .filter(
        (command): command is UploadPartCommand =>
          command instanceof UploadPartCommand
      );
    expect(signedParts.map((command) => command.input)).toEqual([
      expect.objectContaining({
        PartNumber: 1,
        ContentLength: 5 * mebibyte,
      }),
      expect.objectContaining({
        PartNumber: 2,
        ContentLength: 5 * mebibyte,
      }),
      expect.objectContaining({
        PartNumber: 3,
        ContentLength: mebibyte,
      }),
    ]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Tagging: "aistudio-upload-state=temporary",
        }),
      })
    );
  });

  it("aborts multipart state when a part URL cannot be signed", async () => {
    const signingError = new Error("signer unavailable");
    signUrl.mockRejectedValueOnce(signingError);
    const storage = await createRepositoryUploadStorage({
      config: { bucket: "test-bucket", region: "us-east-1" },
      client,
      signUrl: signUrl as unknown as SignUrl,
    });

    await expect(
      storage.createMultipartUpload({
        objectKey:
          "repositories/7/11111111-2222-4333-8444-555555555555/source.pdf",
        contentType: "application/pdf",
        byteSize: 6 * 1024 ** 2,
        partSize: 5 * 1024 ** 2,
        partCount: 2,
        metadata: { repositoryId: "7" },
      })
    ).rejects.toBe(signingError);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-bucket",
          Key: "repositories/7/11111111-2222-4333-8444-555555555555/source.pdf",
          UploadId: "upload-1",
        }),
      })
    );
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof AbortMultipartUploadCommand
      )
    ).toBe(true);
  });
});
