/** @jest-environment node */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetSettings = jest.fn<
  () => Promise<Record<string, string | null | undefined>>
>();
const mockUploadRepositoryTextSource = jest.fn<
  (input: Record<string, unknown>) => Promise<{ key: string; byteSize: number }>
>();
const mockRegisterCanonicalUpload = jest.fn<
  (input: Record<string, unknown>) => Promise<unknown>
>();

jest.mock("@/lib/settings-manager", () => ({ getSettings: mockGetSettings }));
jest.mock("@/lib/aws/s3-client", () => ({
  uploadRepositoryTextSource: mockUploadRepositoryTextSource,
}));
jest.mock("@/lib/repositories/content-platform/ingestion-service", () => ({
  registerCanonicalUpload: mockRegisterCanonicalUpload,
}));

describe("canonical inline-text ingestion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSettings.mockResolvedValue({});
    mockUploadRepositoryTextSource.mockResolvedValue({
      key: "repositories/7/inline/source.txt",
      byteSize: 11,
    });
    mockRegisterCanonicalUpload.mockResolvedValue({
      version: { id: "version-1" },
      inspectJob: { id: "job-1" },
      created: true,
    });
  });

  it("leaves the legacy write untouched while dual-write is disabled", async () => {
    const { registerCanonicalTextIfEnabled } = await import(
      "@/lib/repositories/content-platform/inline-text-ingestion"
    );

    await expect(
      registerCanonicalTextIfEnabled({
        itemId: 3,
        repositoryId: 7,
        userId: 1,
        name: "Quick reference",
        content: "hello world",
      })
    ).resolves.toBeNull();
    expect(mockUploadRepositoryTextSource).not.toHaveBeenCalled();
    expect(mockRegisterCanonicalUpload).not.toHaveBeenCalled();
  });

  it("stores inline text in the repository namespace and registers an immutable version", async () => {
    mockGetSettings.mockResolvedValue({
      CONTENT_PLATFORM_ENABLED: "true",
      CONTENT_DUAL_WRITE_ENABLED: "true",
    });
    const { registerCanonicalTextIfEnabled } = await import(
      "@/lib/repositories/content-platform/inline-text-ingestion"
    );

    await expect(
      registerCanonicalTextIfEnabled({
        itemId: 3,
        repositoryId: 7,
        userId: 1,
        name: "Quick/reference notes",
        content: "hello world",
        traceId: "trace-1",
      })
    ).resolves.toEqual(expect.objectContaining({ created: true }));

    expect(mockUploadRepositoryTextSource).toHaveBeenCalledWith({
      itemId: 3,
      repositoryId: 7,
      userId: 1,
      fileName: "Quick_reference_notes.txt",
      content: "hello world",
    });
    expect(mockRegisterCanonicalUpload).toHaveBeenCalledWith({
      itemId: 3,
      userId: 1,
      objectKey: "repositories/7/inline/source.txt",
      originalFileName: "Quick_reference_notes.txt",
      declaredContentType: "text/plain",
      byteSize: 11,
      sha256:
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      traceId: "trace-1",
    });
  });

  it("rejects inline text above the configured in-memory processing limit before upload", async () => {
    mockGetSettings.mockResolvedValue({
      CONTENT_PLATFORM_ENABLED: "true",
      CONTENT_DUAL_WRITE_ENABLED: "true",
      CONTENT_MAX_FILE_SIZE_GB: "1",
      CONTENT_MAX_OFFICE_SIZE_MB: "1",
    });
    const { registerCanonicalTextIfEnabled } = await import(
      "@/lib/repositories/content-platform/inline-text-ingestion"
    );

    await expect(
      registerCanonicalTextIfEnabled({
        itemId: 3,
        repositoryId: 7,
        userId: 1,
        name: "Oversized notes",
        content: "x".repeat(1024 ** 2 + 1),
      })
    ).rejects.toThrow("Text content must not exceed 1 MiB");
    expect(mockUploadRepositoryTextSource).not.toHaveBeenCalled();
    expect(mockRegisterCanonicalUpload).not.toHaveBeenCalled();
  });
});
