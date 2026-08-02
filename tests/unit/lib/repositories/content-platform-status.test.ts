/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "@jest/globals";
import {
  isRetryableLegacyItemFailure,
  resolveCanonicalItemStatus,
  RETRYABLE_LEGACY_FAILURE_PREFIXES,
} from "@/lib/repositories/content-platform/status-service";

const statusServiceSource = readFileSync(
  resolve(
    process.cwd(),
    "lib/repositories/content-platform/status-service.ts",
  ),
  "utf8",
);

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
    embeddedChunks: 4,
    totalChunks: 9,
    activeEmbeddingComplete: false,
    ...overrides,
  };
}

describe("canonical repository item status", () => {
  it("treats an active canonical generation as authoritative", () => {
    expect(
      resolveCanonicalItemStatus(
        statusRow({
          active: true,
          jobStatus: "failed",
          jobError: "stale error",
          embeddedChunks: 9,
          totalChunks: 9,
        })
      )
    ).toEqual({
      itemId: 7,
      processingStatus: "embedded",
      processingError: null,
      canRetry: false,
      embeddedChunks: 9,
      totalChunks: 9,
      activeEmbeddingComplete: false,
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
      embeddedChunks: 4,
      totalChunks: 9,
      activeEmbeddingComplete: false,
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
    for (const postDeployRecovery of [
      "unified-content-runtime-v2",
      "unified-content-artifact-v3",
      "embedding-concurrency-v1",
      "content-message-sanitizer-v1",
    ] as const) {
      expect(
        resolveCanonicalItemStatus(
          statusRow({
            versionStatus: "cancelled",
            jobStatus: "cancelled",
            jobError: "Awaiting the replacement runtime",
            postDeployRecovery,
          })
        )
      ).toEqual({
        itemId: 7,
        processingStatus: "retrying",
        processingError: null,
        canRetry: false,
        embeddedChunks: 4,
        totalChunks: 9,
        activeEmbeddingComplete: false,
      });
    }
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

});

describe("canonical repository item embedding coverage", () => {
  it("checks active-generation embedding completeness independently of newer builds", () => {
    expect(statusServiceSource).toContain(
      "activeEmbeddingComplete: sql<boolean>`NOT EXISTS (",
    );
    expect(statusServiceSource).toContain(
      "active_chunk.index_generation_id = ${knowledgeRepositories.activeIndexGenerationId}",
    );
    expect(statusServiceSource).toContain("active_chunk.embedding IS NULL");
    expect(statusServiceSource).toContain(
      'eq(repositoryItems.lifecycleStatus, "active")',
    );
    expect(statusServiceSource).toContain(
      'context.lifecycleStatus !== "active"',
    );
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

  it("carries counts through every status branch", () => {
    const branches: Array<
      Partial<Parameters<typeof resolveCanonicalItemStatus>[0]>
    > = [
      { active: true },
      { postDeployRecovery: "embedding-concurrency-v1" },
      { versionStatus: "failed", jobStatus: "failed" },
      { versionStatus: "completed" },
      { jobStatus: "pending", jobAttempt: 1 },
      {},
    ];

    for (const overrides of branches) {
      expect(resolveCanonicalItemStatus(statusRow(overrides))).toMatchObject({
        embeddedChunks: 4,
        totalChunks: 9,
        activeEmbeddingComplete: false,
      });
    }
  });
});

describe("legacy repository item retryability", () => {
  it.each(RETRYABLE_LEGACY_FAILURE_PREFIXES)(
    "allows managers to retry a failed item with the %s prefix",
    (prefix) => {
      expect(
        isRetryableLegacyItemFailure("failed", `${prefix}. Retry this item.`),
      ).toBe(true);
    },
  );

  it("rejects arbitrary failure messages", () => {
    expect(
      isRetryableLegacyItemFailure("failed", "An unrelated provider failed"),
    ).toBe(false);
  });

  it("never retries completed items", () => {
    expect(
      isRetryableLegacyItemFailure(
        "completed",
        `${RETRYABLE_LEGACY_FAILURE_PREFIXES[0]}. Retry this item.`,
      ),
    ).toBe(false);
  });

  it("allows known embedding failures to retry through the canonical pipeline", () => {
    expect(
      isRetryableLegacyItemFailure(
        "embedding_failed",
        `${RETRYABLE_LEGACY_FAILURE_PREFIXES[0]}. Retry this item.`,
      ),
    ).toBe(true);
  });
});
