/** @jest-environment node */

import { jest } from "@jest/globals";

const mockExecuteTransaction = jest.fn();
const mockGetSettings = jest.fn<() => Promise<Record<string, string | null>>>();

jest.mock("@/lib/db/drizzle-client", () => ({
  executeTransaction: mockExecuteTransaction,
}));
jest.mock("@/lib/settings-manager", () => ({ getSettings: mockGetSettings }));

describe("canonical upload registration rollout", () => {
  let registerCanonicalUpload: typeof import("@/lib/repositories/content-platform/ingestion-service").registerCanonicalUpload;
  let registerCanonicalUploadIfEnabled: typeof import("@/lib/repositories/content-platform/ingestion-service").registerCanonicalUploadIfEnabled;

  beforeAll(async () => {
    ({ registerCanonicalUpload, registerCanonicalUploadIfEnabled } = await import(
      "@/lib/repositories/content-platform/ingestion-service"
    ));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteTransaction.mockReset();
    mockGetSettings.mockResolvedValue({});
  });

  it("does not touch the canonical database while rollout flags are off", async () => {
    await expect(
      registerCanonicalUploadIfEnabled({
        itemId: 1,
        userId: 2,
        objectKey: "repositories/3/file/document.pdf",
        originalFileName: "document.pdf",
        declaredContentType: "application/pdf",
        byteSize: 1024,
      })
    ).resolves.toBeNull();
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("requires both the master and dual-write flags", async () => {
    mockGetSettings.mockResolvedValue({
      CONTENT_PLATFORM_ENABLED: "false",
      CONTENT_DUAL_WRITE_ENABLED: "true",
    });
    await expect(
      registerCanonicalUploadIfEnabled({
        itemId: 1,
        userId: 2,
        objectKey: "repositories/3/file/document.pdf",
        originalFileName: "document.pdf",
        declaredContentType: "application/pdf",
        byteSize: 1024,
      })
    ).resolves.toBeNull();
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("validates source integrity fields before starting a transaction", async () => {
    await expect(
      registerCanonicalUpload({
        itemId: 1,
        userId: 2,
        objectKey: "repositories/3/file/document.pdf",
        originalFileName: "document.pdf",
        declaredContentType: "application/pdf",
        byteSize: 1024,
        sha256: "NOT-A-SHA",
      })
    ).rejects.toThrow("SHA-256");
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("rejects an object key owned by a different repository", async () => {
    const forUpdate = jest.fn(() =>
      Promise.resolve([{ id: 1, repositoryId: 3 }])
    );
    const tx = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
    };
    mockExecuteTransaction.mockImplementation(async (...args: unknown[]) => {
      const operation = args[0];
      if (typeof operation !== "function") {
        throw new Error("Expected a transaction callback");
      }
      return (operation as (transaction: unknown) => Promise<unknown>)(tx);
    });

    await expect(
      registerCanonicalUpload({
        itemId: 1,
        userId: 2,
        objectKey:
          "repositories/4/11111111-2222-4333-8444-555555555555/document.pdf",
        originalFileName: "document.pdf",
        declaredContentType: "application/pdf",
        byteSize: 1024,
      })
    ).rejects.toThrow("outside the repository source namespace");
    expect(forUpdate).toHaveBeenCalledWith("update");
  });
});
