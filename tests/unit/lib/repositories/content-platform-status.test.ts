/** @jest-environment node */

import { describe, expect, it } from "@jest/globals";
import { resolveCanonicalItemStatus } from "@/lib/repositories/content-platform/status-service";

function statusRow(
  overrides: Partial<Parameters<typeof resolveCanonicalItemStatus>[0]> = {}
): Parameters<typeof resolveCanonicalItemStatus>[0] {
  return {
    itemId: 7,
    versionStatus: "pending",
    storageStatus: "quarantined",
    inspectionStatus: "pending",
    jobStatus: "pending",
    jobAttempt: 0,
    jobMaxAttempts: 3,
    jobError: null,
    postDeployRecovery: null,
    active: false,
    buildingGeneration: false,
    failedGeneration: false,
    generationError: null,
    ...overrides,
  };
}

describe("canonical repository item status", () => {
  it("treats an active canonical generation as authoritative", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({ active: true, jobStatus: "failed", jobError: "stale error" })
      )
    ).toEqual({
      itemId: 7,
      processingStatus: "embedded",
      processingError: null,
      canRetry: false,
    });
  });

  it("shows a completed version as embedding until its generation activates", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          versionStatus: "completed",
          storageStatus: "available",
          inspectionStatus: "clean",
          jobStatus: "succeeded",
        })
      ).processingStatus
    ).toBe("processing_embeddings");
  });

  it("exposes terminal job failures and permits a safe retry", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          versionStatus: "failed",
          jobStatus: "failed",
          jobAttempt: 3,
          jobMaxAttempts: 3,
          jobError: "The document could not be parsed",
        })
      )
    ).toEqual({
      itemId: 7,
      processingStatus: "failed",
      processingError: "The document could not be parsed",
      canRetry: true,
    });
  });

  it("does not permit retrying content blocked by security inspection", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          versionStatus: "failed",
          storageStatus: "blocked",
          inspectionStatus: "blocked",
        })
      ).canRetry
    ).toBe(false);
  });

  it("exposes an early failed job as terminal instead of retrying forever", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          jobStatus: "failed",
          jobAttempt: 1,
          jobMaxAttempts: 20,
          jobError: "Item version object key is outside its repository namespace",
        })
      )
    ).toMatchObject({
      processingStatus: "failed",
      processingError: "Item version object key is outside its repository namespace",
      canRetry: true,
    });
  });

  it("exposes cancelled pre-deployment jobs as retryable failures", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          versionStatus: "cancelled",
          jobStatus: "cancelled",
          jobError: "Content processing was disabled during deployment",
        })
      )
    ).toMatchObject({
      processingStatus: "failed",
      processingError: "Content processing was disabled during deployment",
      canRetry: true,
    });
  });

  it("keeps post-deployment recovery quarantined and disables manual retry", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          versionStatus: "cancelled",
          jobStatus: "cancelled",
          jobError: "Awaiting the replacement runtime",
          postDeployRecovery: "unified-content-runtime-v2",
        })
      )
    ).toEqual({
      itemId: 7,
      processingStatus: "retrying",
      processingError: null,
      canRetry: false,
    });
  });

  it("shows pending work with a consumed attempt as retrying", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({ jobStatus: "pending", jobAttempt: 1, jobMaxAttempts: 5 })
      ).processingStatus
    ).toBe("retrying");
  });

  it("does not let an older failed generation mask a user-requested retry", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({ failedGeneration: true, jobStatus: "pending" })
      ).processingStatus
    ).toBe("pending");
  });

  it("exposes a terminal failed embedding generation", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          versionStatus: "completed",
          storageStatus: "available",
          inspectionStatus: "clean",
          jobStatus: "succeeded",
          failedGeneration: true,
          generationError: "Embedding provider rejected the model",
        })
      )
    ).toMatchObject({
      processingStatus: "failed",
      processingError: "Embedding provider rejected the model",
      canRetry: true,
    });
  });
});
