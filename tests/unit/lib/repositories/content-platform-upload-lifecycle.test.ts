/** @jest-environment node */

import { jest } from "@jest/globals";
import {
  cleanupExpiredRepositoryUploads,
  UPLOAD_CLEANUP_LEASE_MS,
  type RepositoryUploadCleanupClaim,
  type RepositoryUploadLifecycleDependencies,
} from "@/lib/repositories/content-platform/upload-lifecycle-service";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function claim(
  sessionId: string,
  uploadMethod: "single" | "multipart" = "single",
  cleanupPhase: "initial" | "final" = "initial"
): RepositoryUploadCleanupClaim {
  return {
    sessionId,
    objectKey: `repositories/7/${sessionId}/source.pdf`,
    uploadMethod,
    multipartUploadId:
      uploadMethod === "multipart" ? `multipart-${sessionId}` : null,
    claimedAt: new Date(NOW.getTime() - 1_000),
    cleanupPhase,
  };
}

function dependencies(
  claims: RepositoryUploadCleanupClaim[]
): RepositoryUploadLifecycleDependencies & {
  claim: jest.Mock<RepositoryUploadLifecycleDependencies["claim"]>;
  abortMultipartUpload: jest.Mock<
    RepositoryUploadLifecycleDependencies["abortMultipartUpload"]
  >;
  deleteObjectVersions: jest.Mock<
    RepositoryUploadLifecycleDependencies["deleteObjectVersions"]
  >;
  finalize: jest.Mock<RepositoryUploadLifecycleDependencies["finalize"]>;
} {
  return {
    claim: jest.fn(async () => claims),
    abortMultipartUpload: jest.fn(async () => undefined),
    deleteObjectVersions: jest.fn(async () => 0),
    finalize: jest.fn(async () => true),
  };
}

describe("repository upload lifecycle", () => {
  it("claims expired uploads with a stale-lease cutoff", async () => {
    const lifecycleDependencies = dependencies([claim("session-1")]);

    await expect(
      cleanupExpiredRepositoryUploads(
        { now: NOW, batchSize: 7 },
        lifecycleDependencies
      )
    ).resolves.toEqual({ claimed: 1, cleaned: 1 });

    expect(lifecycleDependencies.claim).toHaveBeenCalledWith({
      now: NOW,
      staleLeaseBefore: new Date(NOW.getTime() - UPLOAD_CLEANUP_LEASE_MS),
      batchSize: 7,
    });
  });

  it("aborts multipart state before permanently deleting object versions", async () => {
    const lifecycleDependencies = dependencies([
      claim("11111111-2222-4333-8444-555555555555", "multipart"),
    ]);
    const operations: string[] = [];
    lifecycleDependencies.abortMultipartUpload.mockImplementation(async () => {
      operations.push("abort");
    });
    lifecycleDependencies.deleteObjectVersions.mockImplementation(async () => {
      operations.push("delete-versions");
      return 2;
    });
    lifecycleDependencies.finalize.mockImplementation(async () => {
      operations.push("finalize");
      return true;
    });

    await cleanupExpiredRepositoryUploads(
      { now: NOW },
      lifecycleDependencies
    );

    expect(operations).toEqual(["abort", "delete-versions", "finalize"]);
  });

  it("treats an already-missing multipart upload as idempotent cleanup", async () => {
    const lifecycleDependencies = dependencies([
      claim("11111111-2222-4333-8444-555555555555", "multipart"),
    ]);
    lifecycleDependencies.abortMultipartUpload.mockRejectedValue({
      name: "NoSuchUpload",
      $metadata: { httpStatusCode: 404 },
    });

    await expect(
      cleanupExpiredRepositoryUploads({ now: NOW }, lifecycleDependencies)
    ).resolves.toEqual({ claimed: 1, cleaned: 1 });

    expect(lifecycleDependencies.deleteObjectVersions).toHaveBeenCalled();
    expect(lifecycleDependencies.finalize).toHaveBeenCalled();
  });

  it("performs a delayed final sweep for a PUT that lands after the initial cleanup", async () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const initial = claim(sessionId, "single", "initial");
    const final = {
      ...claim(sessionId, "single", "final"),
      claimedAt: new Date(NOW.getTime() + UPLOAD_CLEANUP_LEASE_MS),
    };
    const lifecycleDependencies = dependencies([]);
    lifecycleDependencies.claim
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([final]);
    const currentObjects = new Set([initial.objectKey]);
    lifecycleDependencies.deleteObjectVersions.mockImplementation(
      async (objectKey) => (currentObjects.delete(objectKey) ? 1 : 0)
    );

    await cleanupExpiredRepositoryUploads(
      { now: NOW },
      lifecycleDependencies
    );
    expect(currentObjects.size).toBe(0);

    // Simulate a signed PUT accepted just before expiry finishing after the
    // first sweep. The session remains retryable instead of terminal aborted.
    currentObjects.add(initial.objectKey);
    await cleanupExpiredRepositoryUploads(
      { now: new Date(NOW.getTime() + UPLOAD_CLEANUP_LEASE_MS) },
      lifecycleDependencies
    );

    expect(currentObjects.size).toBe(0);
    expect(lifecycleDependencies.finalize).toHaveBeenNthCalledWith(1, initial);
    expect(lifecycleDependencies.finalize).toHaveBeenNthCalledWith(2, final);
  });

  it("continues other claims and leaves failed cleanup leased for retry", async () => {
    const first = claim("11111111-2222-4333-8444-555555555555");
    const second = claim("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const lifecycleDependencies = dependencies([first, second]);
    lifecycleDependencies.deleteObjectVersions.mockImplementation(
      async (objectKey) => {
        if (objectKey === first.objectKey) throw new Error("S3 unavailable");
        return 1;
      }
    );

    await expect(
      cleanupExpiredRepositoryUploads({ now: NOW }, lifecycleDependencies)
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "1 repository upload cleanup operation(s) failed",
    });

    expect(lifecycleDependencies.finalize).not.toHaveBeenCalledWith(first);
    expect(lifecycleDependencies.finalize).toHaveBeenCalledWith(second);
  });

  it.each([0, 101])("rejects unsafe batch size %s", async (batchSize) => {
    const lifecycleDependencies = dependencies([]);

    await expect(
      cleanupExpiredRepositoryUploads(
        { now: NOW, batchSize },
        lifecycleDependencies
      )
    ).rejects.toThrow("between 1 and 100");
    expect(lifecycleDependencies.claim).not.toHaveBeenCalled();
  });
});
