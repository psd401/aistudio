/** @jest-environment node */

import { jest } from "@jest/globals";
import { Settings } from "@/lib/settings-manager";
import { resolveRepositoryUploadStorageConfig } from "@/lib/repositories/content-platform/upload-service";

describe("canonical upload storage configuration", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses the database-first S3 setting for canonical uploads", async () => {
    const getS3Spy = jest.spyOn(Settings, "getS3").mockResolvedValue({
      bucket: "database-documents",
      region: "us-west-2",
    });

    await expect(resolveRepositoryUploadStorageConfig()).resolves.toEqual({
      bucket: "database-documents",
      region: "us-west-2",
    });
    expect(getS3Spy).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when the setting and its environment fallback are empty", async () => {
    jest.spyOn(Settings, "getS3").mockResolvedValue({
      bucket: null,
      region: "us-east-1",
    });

    await expect(resolveRepositoryUploadStorageConfig()).rejects.toThrow(
      "S3_BUCKET is not configured"
    );
  });
});
