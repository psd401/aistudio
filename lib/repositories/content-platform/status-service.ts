import { and, desc, eq, sql } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryIndexGenerations,
  repositoryItemChunks,
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
} from "@/lib/db/schema";
import { CONTENT_PROCESSING_MAX_ATTEMPTS } from "./job-state";

export type CanonicalItemProcessingStatus =
  | "pending"
  | "processing"
  | "retrying"
  | "processing_embeddings"
  | "embedded"
  | "failed";

export interface CanonicalRepositoryItemStatus {
  itemId: number;
  processingStatus: CanonicalItemProcessingStatus;
  processingError: string | null;
  canRetry: boolean;
}

interface CanonicalStatusRow {
  itemId: number;
  versionStatus: "pending" | "processing" | "completed" | "failed" | "cancelled";
  storageStatus: "quarantined" | "available" | "blocked" | "deleted";
  inspectionStatus: "pending" | "clean" | "blocked" | "error" | "not_required";
  jobStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  jobAttempt: number | null;
  jobMaxAttempts: number | null;
  jobError: string | null;
  active: boolean;
  buildingGeneration: boolean;
  failedGeneration: boolean;
  generationError: string | null;
}

export function resolveCanonicalItemStatus(
  row: CanonicalStatusRow
): CanonicalRepositoryItemStatus {
  if (row.active) {
    return {
      itemId: row.itemId,
      processingStatus: "embedded",
      processingError: null,
      canRetry: false,
    };
  }

  const terminalFailure =
    row.versionStatus === "failed" ||
    row.versionStatus === "cancelled" ||
    row.storageStatus === "blocked" ||
    row.inspectionStatus === "blocked" ||
    row.inspectionStatus === "error" ||
    (row.failedGeneration &&
      !row.buildingGeneration &&
      row.versionStatus === "completed" &&
      row.jobStatus === "succeeded") ||
    row.jobStatus === "failed" ||
    row.jobStatus === "cancelled";
  if (terminalFailure) {
    return {
      itemId: row.itemId,
      processingStatus: "failed",
      processingError:
        row.jobError ??
        row.generationError ??
        (row.inspectionStatus === "blocked"
          ? "The file did not pass the required security inspection."
          : "Content processing failed. Retry the item or contact support."),
      canRetry: row.storageStatus !== "blocked" && row.inspectionStatus !== "blocked",
    };
  }

  if (row.versionStatus === "completed") {
    return {
      itemId: row.itemId,
      processingStatus: "processing_embeddings",
      processingError: null,
      canRetry: false,
    };
  }

  if (
    (row.jobStatus === "pending" || row.jobStatus === "queued") &&
    row.jobAttempt !== null &&
    row.jobAttempt > 0
  ) {
    return {
      itemId: row.itemId,
      processingStatus: "retrying",
      processingError: null,
      canRetry: false,
    };
  }

  return {
    itemId: row.itemId,
    processingStatus:
      row.jobStatus === "running" || row.versionStatus === "processing"
        ? "processing"
        : "pending",
    processingError: null,
    canRetry: false,
  };
}

/**
 * Project the canonical version/job/generation state used by Repository Manager.
 * Legacy item status is deliberately not trusted once an immutable version exists.
 */
export async function getCanonicalRepositoryItemStatuses(
  repositoryId: number
): Promise<Map<number, CanonicalRepositoryItemStatus>> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          itemId: repositoryItems.id,
          versionStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          jobStatus: repositoryProcessingJobs.status,
          jobAttempt: repositoryProcessingJobs.attempt,
          jobMaxAttempts: repositoryProcessingJobs.maxAttempts,
          jobError: repositoryProcessingJobs.lastErrorMessage,
          active: sql<boolean>`EXISTS (
            SELECT 1
            FROM ${repositoryItemChunks} active_chunk
            WHERE active_chunk.item_version_id = ${repositoryItemVersions.id}
              AND active_chunk.index_generation_id = ${knowledgeRepositories.activeIndexGenerationId}
          )`,
          buildingGeneration: sql<boolean>`EXISTS (
            SELECT 1
            FROM ${repositoryItemChunks} building_chunk
            INNER JOIN ${repositoryIndexGenerations} building_generation
              ON building_generation.id = building_chunk.index_generation_id
            WHERE building_chunk.item_version_id = ${repositoryItemVersions.id}
              AND building_generation.status = 'building'
          )`,
          failedGeneration: sql<boolean>`EXISTS (
            SELECT 1
            FROM ${repositoryItemChunks} failed_chunk
            INNER JOIN ${repositoryIndexGenerations} failed_generation
              ON failed_generation.id = failed_chunk.index_generation_id
            WHERE failed_chunk.item_version_id = ${repositoryItemVersions.id}
              AND failed_generation.status = 'failed'
          )`,
          generationError: sql<string | null>`(
            SELECT failed_generation.error_message
            FROM ${repositoryItemChunks} failed_chunk
            INNER JOIN ${repositoryIndexGenerations} failed_generation
              ON failed_generation.id = failed_chunk.index_generation_id
            WHERE failed_chunk.item_version_id = ${repositoryItemVersions.id}
              AND failed_generation.status = 'failed'
            ORDER BY failed_generation.created_at DESC
            LIMIT 1
          )`,
        })
        .from(repositoryItems)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryItems.currentVersionId)
        )
        .innerJoin(
          knowledgeRepositories,
          eq(knowledgeRepositories.id, repositoryItems.repositoryId)
        )
        .leftJoin(
          repositoryProcessingJobs,
          and(
            eq(repositoryProcessingJobs.itemVersionId, repositoryItemVersions.id),
            eq(repositoryProcessingJobs.stage, "inspect")
          )
        )
        .where(eq(repositoryItems.repositoryId, repositoryId)),
    "contentPlatform.getCanonicalRepositoryItemStatuses"
  );

  return new Map(
    rows.map((row) => {
      const status = resolveCanonicalItemStatus(row);
      return [status.itemId, status];
    })
  );
}

export interface RetryCanonicalItemResult {
  itemVersionId: string;
  processingJobId: string;
}

/** Reset a terminal current version to its durable inspect job for reprocessing. */
export async function retryCanonicalRepositoryItem(
  itemId: number,
  traceId?: string
): Promise<RetryCanonicalItemResult> {
  return executeTransaction(
    async (tx) => {
      const [context] = await tx
        .select({
          itemVersionId: repositoryItemVersions.id,
          storageStatus: repositoryItemVersions.storageStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
        })
        .from(repositoryItems)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryItems.currentVersionId)
        )
        .where(eq(repositoryItems.id, itemId))
        .limit(1)
        .for("update");
      if (!context) throw new Error("The item has no canonical version to retry");
      if (context.storageStatus === "blocked" || context.inspectionStatus === "blocked") {
        throw new Error("Security-blocked content cannot be retried");
      }

      const [job] = await tx
        .select()
        .from(repositoryProcessingJobs)
        .where(
          and(
            eq(repositoryProcessingJobs.itemVersionId, context.itemVersionId),
            eq(repositoryProcessingJobs.stage, "inspect")
          )
        )
        .orderBy(desc(repositoryProcessingJobs.createdAt))
        .limit(1)
        .for("update");
      if (!job) throw new Error("The item has no processing job to retry");
      if (
        job.status !== "failed" &&
        job.status !== "cancelled" &&
        job.status !== "succeeded"
      ) {
        throw new Error("The item is already being processed");
      }

      const now = new Date();
      await tx
        .update(repositoryIndexGenerations)
        .set({
          status: "failed",
          errorMessage: "Superseded by a user-requested retry",
        })
        .where(
          sql`${repositoryIndexGenerations.id} IN (
            SELECT retry_chunk.index_generation_id
            FROM ${repositoryItemChunks} retry_chunk
            WHERE retry_chunk.item_version_id = ${context.itemVersionId}
          ) AND ${repositoryIndexGenerations.status} = 'building'`
        );
      await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "pending",
          attempt: 0,
          maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          traceId: traceId ?? job.traceId,
          lastErrorCode: null,
          lastErrorMessage: null,
          metrics: {},
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        })
        .where(eq(repositoryProcessingJobs.id, job.id));
      await tx
        .update(repositoryItemVersions)
        .set({
          storageStatus: "quarantined",
          inspectionStatus: "pending",
          inspectionDetails: {},
          processingStatus: "pending",
        })
        .where(eq(repositoryItemVersions.id, context.itemVersionId));
      await tx
        .update(repositoryItems)
        .set({ processingStatus: "pending", processingError: null, updatedAt: now })
        .where(eq(repositoryItems.id, itemId));

      return { itemVersionId: context.itemVersionId, processingJobId: job.id };
    },
    "contentPlatform.retryCanonicalRepositoryItem"
  );
}
