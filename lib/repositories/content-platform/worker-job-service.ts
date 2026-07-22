import { and, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryItemChunks,
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  type RepositoryProcessingJobRow,
  type RepositoryProcessingMetrics,
} from "@/lib/db/schema";

export type RestartableManagedService =
  | "textract"
  | "bedrock-data-automation";

export interface RepositoryProcessingJobMessage {
  jobId: string;
  itemVersionId: string;
}

export interface ClaimRepositoryProcessingJobOptions {
  now?: Date;
  leaseDurationMs?: number;
}

export interface RepositoryProcessingFailureDecision {
  terminal: boolean;
  code: string;
  message: string;
  resetManagedService?: RestartableManagedService;
}

export interface RepositoryProcessingDlqReconciliationResult {
  acknowledge: boolean;
  recovered: boolean;
}

export type RepositoryProcessingFailureResult =
  | { action: "ignore" }
  | { action: "terminal"; code: string }
  | { action: "retry"; delaySeconds: number };

export interface RecordRepositoryProcessingFailureOptions {
  now?: Date;
  retryDelaySeconds: (attempt: number) => number;
}

/** Remove every identifier/output that belongs to one failed provider run. */
export function resetManagedServiceMetrics(
  source: RepositoryProcessingMetrics,
  provider: RestartableManagedService
): RepositoryProcessingMetrics {
  const metrics = { ...source };
  delete metrics.waitReason;
  delete metrics.waitStartedAt;
  if (provider === "textract") {
    delete metrics.textractJobId;
    delete metrics.textractObjectKey;
    return metrics;
  }
  delete metrics.bdaInvocationArn;
  delete metrics.bdaSourceObjectKey;
  delete metrics.bdaOutputPrefix;
  delete metrics.bdaResultObjectKey;
  delete metrics.mediaDurationMs;
  delete metrics.mediaFormat;
  delete metrics.mediaCodec;
  delete metrics.mediaChannels;
  delete metrics.frameRate;
  delete metrics.frameWidth;
  delete metrics.frameHeight;
  delete metrics.wordCount;
  delete metrics.topicCount;
  delete metrics.shotCount;
  delete metrics.chapterCount;
  delete metrics.speakerCount;
  return metrics;
}

/**
 * Block the unsafe version and finish its job. Only a block for the current
 * version may revoke the logical item; a delayed scan result for a superseded
 * upload must not take a newer clean version offline.
 */
export async function recordRepositorySecurityBlock(
  message: RepositoryProcessingJobMessage,
  providerStatus: string,
  now = new Date()
): Promise<void> {
  await executeTransaction(async (tx) => {
    const [job] = await tx
      .select({ itemVersionId: repositoryProcessingJobs.itemVersionId })
      .from(repositoryProcessingJobs)
      .where(eq(repositoryProcessingJobs.id, message.jobId))
      .limit(1)
      .for("update");
    if (!job || job.itemVersionId !== message.itemVersionId) {
      throw new Error("Security inspection job does not match its item version");
    }
    await tx
      .update(repositoryItemVersions)
      .set({
        inspectionStatus: "blocked",
        inspectionDetails: {
          provider: "guardduty",
          status: providerStatus,
        },
        storageStatus: "blocked",
        processingStatus: "failed",
      })
      .where(eq(repositoryItemVersions.id, message.itemVersionId));
    const [version] = await tx
      .select({ itemId: repositoryItemVersions.itemId })
      .from(repositoryItemVersions)
      .where(eq(repositoryItemVersions.id, message.itemVersionId))
      .limit(1);
    if (version) {
      await tx
        .update(repositoryItems)
        .set({
          lifecycleStatus: "unavailable",
          processingStatus: "failed",
          processingError: `Security inspection result: ${providerStatus}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(repositoryItems.id, version.itemId),
            eq(repositoryItems.currentVersionId, message.itemVersionId)
          )
        );
    }
    await tx
      .update(repositoryProcessingJobs)
      .set({
        status: "failed",
        attempt: sql`${repositoryProcessingJobs.maxAttempts}`,
        lastErrorCode: "SECURITY_INSPECTION_BLOCKED",
        lastErrorMessage: providerStatus,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(repositoryProcessingJobs.id, message.jobId));
  }, "contentProcessor.blockVersion");
}

const DEFAULT_LEASE_DURATION_MS = 16 * 60 * 1_000;

/**
 * Check whether a valid DLQ delivery already has another durable recovery
 * owner. Queued rows first require `reconcileRepositoryProcessingDlqMessage`;
 * terminal failures and version mismatches stay visible for diagnosis.
 */
export async function canAcknowledgeRepositoryProcessingDlqMessage(
  message: RepositoryProcessingJobMessage
): Promise<boolean> {
  const [job] = await executeQuery(
    (db) =>
      db
        .select({
          itemVersionId: repositoryProcessingJobs.itemVersionId,
          status: repositoryProcessingJobs.status,
        })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, message.jobId))
        .limit(1),
    "contentProcessor.processingDlqDisposition"
  );
  return (
    !job ||
    (job.itemVersionId === message.itemVersionId &&
      job.status !== "queued" &&
      job.status !== "failed")
  );
}

/**
 * Reconcile a canonical processing DLQ record with the durable database outbox.
 * A queue delivery can reach the DLQ while the row is still `queued` when the
 * database is unavailable during every Lambda receive. Atomically returning
 * that row to `pending` makes the minute sweep its recovery owner. True failed
 * jobs stay in the DLQ so their alarm remains actionable instead of being
 * silently cleared.
 */
export async function reconcileRepositoryProcessingDlqMessage(
  message: RepositoryProcessingJobMessage,
  now = new Date()
): Promise<RepositoryProcessingDlqReconciliationResult> {
  return executeTransaction(async (tx) => {
    const [job] = await tx
      .select({
        itemVersionId: repositoryProcessingJobs.itemVersionId,
        status: repositoryProcessingJobs.status,
      })
      .from(repositoryProcessingJobs)
      .where(eq(repositoryProcessingJobs.id, message.jobId))
      .limit(1)
      .for("update");
    if (!job) return { acknowledge: true, recovered: false };
    if (job.itemVersionId !== message.itemVersionId) {
      return { acknowledge: false, recovered: false };
    }
    if (job.status === "failed") {
      return { acknowledge: false, recovered: false };
    }
    if (job.status !== "queued") {
      return { acknowledge: true, recovered: false };
    }

    await tx
      .update(repositoryProcessingJobs)
      .set({
        status: "pending",
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "PROCESSING_DLQ_RECOVERED",
        lastErrorMessage:
          "Recovered a queued job after its SQS delivery reached the DLQ",
        finishedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(repositoryProcessingJobs.id, message.jobId),
          eq(repositoryProcessingJobs.itemVersionId, message.itemVersionId),
          eq(repositoryProcessingJobs.status, "queued")
        )
      );
    return { acknowledge: true, recovered: true };
  }, "contentProcessor.reconcileProcessingDlq");
}

/**
 * Claim one durable processing job.
 *
 * A version can remain in the active retrieval generation while a newer
 * processor or embedding configuration rebuilds it in the background. Do not
 * infer job completion from active chunks: the durable job state is the source
 * of truth, and a succeeded job already provides the stale-delivery no-op.
 */
export async function claimRepositoryProcessingJob(
  message: RepositoryProcessingJobMessage,
  workerId: string,
  options: ClaimRepositoryProcessingJobOptions = {}
): Promise<RepositoryProcessingJobRow | null> {
  const now = options.now ?? new Date();
  const leaseDurationMs =
    options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;

  return executeTransaction(
    async (tx) => {
      const [job] = await tx
        .select()
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, message.jobId))
        .limit(1)
        .for("update");
      if (!job || job.itemVersionId !== message.itemVersionId) {
        throw new Error("Processing job does not match its item version");
      }
      if (
        job.status === "succeeded" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        return null;
      }
      if (
        job.status === "running" &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return null;
      }
      if (
        job.status === "pending" &&
        job.availableAt.getTime() > now.getTime()
      ) {
        return null;
      }
      const [context] =
        job.stage === "inspect"
          ? await tx
              .select({
                itemId: repositoryItemVersions.itemId,
                active: sql<boolean>`EXISTS (
                  SELECT 1
                  FROM ${repositoryItemChunks} active_chunk
                  JOIN ${repositoryItems} active_item
                    ON active_item.id = active_chunk.item_id
                  JOIN ${knowledgeRepositories} active_repository
                    ON active_repository.id = active_item.repository_id
                  WHERE active_chunk.item_version_id = repository_item_versions.id
                    AND active_chunk.index_generation_id = active_repository.active_index_generation_id
                    AND active_item.current_version_id = repository_item_versions.id
                    AND active_item.lifecycle_status = 'active'
                )`,
              })
              .from(repositoryItemVersions)
              .where(eq(repositoryItemVersions.id, message.itemVersionId))
              .limit(1)
          : [];
      if (job.attempt >= job.maxAttempts) {
        const errorMessage = "Processing job exhausted its retry budget";
        if (!context?.active) {
          await tx
            .update(repositoryItemVersions)
            .set({ inspectionStatus: "error", processingStatus: "failed" })
            .where(eq(repositoryItemVersions.id, message.itemVersionId));
        }
        if (context && !context.active) {
          await tx
            .update(repositoryItems)
            .set({
              processingStatus: "failed",
              processingError: errorMessage,
              updatedAt: now,
            })
            .where(
              and(
                eq(repositoryItems.id, context.itemId),
                eq(repositoryItems.currentVersionId, message.itemVersionId)
              )
            );
        }
        await tx
          .update(repositoryProcessingJobs)
          .set({
            status: "failed",
            lastErrorCode: "RETRY_BUDGET_EXHAUSTED",
            lastErrorMessage: errorMessage,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(repositoryProcessingJobs.id, job.id));
        return null;
      }

      const [claimed] = await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "running",
          attempt: job.attempt + 1,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
          startedAt: job.startedAt ?? now,
          finishedAt: null,
          updatedAt: now,
        })
        .where(eq(repositoryProcessingJobs.id, job.id))
        .returning();
      if (claimed && job.stage === "inspect" && !context?.active) {
        await tx
          .update(repositoryItemVersions)
          .set({ processingStatus: "processing" })
          .where(eq(repositoryItemVersions.id, message.itemVersionId));
        if (context) {
          await tx
            .update(repositoryItems)
            .set({
              processingStatus: "processing",
              processingError: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(repositoryItems.id, context.itemId),
                eq(repositoryItems.currentVersionId, message.itemVersionId)
              )
            );
        }
      }
      return claimed ?? null;
    },
    "contentProcessor.claimJob"
  );
}

/**
 * Persist one worker failure without taking a previously active snapshot
 * offline. Security blocks are handled separately by the worker and remain the
 * only failure path allowed to revoke an active version immediately.
 */
export async function recordRepositoryProcessingFailure(
  message: RepositoryProcessingJobMessage,
  decision: RepositoryProcessingFailureDecision,
  options: RecordRepositoryProcessingFailureOptions
): Promise<RepositoryProcessingFailureResult> {
  const now = options.now ?? new Date();
  return executeTransaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(repositoryProcessingJobs)
      .where(eq(repositoryProcessingJobs.id, message.jobId))
      .limit(1)
      .for("update");
    if (
      !job ||
      job.itemVersionId !== message.itemVersionId ||
      job.status === "succeeded" ||
      job.status === "cancelled"
    ) {
      return { action: "ignore" };
    }

    const terminal = decision.terminal || job.attempt >= job.maxAttempts;
    if (terminal) {
      const code = decision.terminal
        ? decision.code
        : "RETRY_BUDGET_EXHAUSTED";
      await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "failed",
          attempt: job.maxAttempts,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          lastErrorMessage: decision.message,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(repositoryProcessingJobs.id, job.id));

      const [version] = await tx
        .select({
          itemId: repositoryItemVersions.itemId,
          active: sql<boolean>`EXISTS (
            SELECT 1
            FROM ${repositoryItemChunks} active_chunk
            JOIN ${repositoryItems} active_item
              ON active_item.id = active_chunk.item_id
            JOIN ${knowledgeRepositories} active_repository
              ON active_repository.id = active_item.repository_id
            WHERE active_chunk.item_version_id = repository_item_versions.id
              AND active_chunk.index_generation_id = active_repository.active_index_generation_id
              AND active_item.current_version_id = repository_item_versions.id
              AND active_item.lifecycle_status = 'active'
          )`,
        })
        .from(repositoryItemVersions)
        .where(eq(repositoryItemVersions.id, message.itemVersionId))
        .limit(1);
      if (!version?.active) {
        await tx
          .update(repositoryItemVersions)
          .set({ inspectionStatus: "error", processingStatus: "failed" })
          .where(eq(repositoryItemVersions.id, message.itemVersionId));
      }
      if (version && !version.active) {
        await tx
          .update(repositoryItems)
          .set({
            processingStatus: "failed",
            processingError: decision.message,
            updatedAt: now,
          })
          .where(
            and(
              eq(repositoryItems.id, version.itemId),
              eq(repositoryItems.currentVersionId, message.itemVersionId)
            )
          );
      }
      return { action: "terminal", code };
    }

    const delaySeconds = options.retryDelaySeconds(job.attempt);
    const restartManagedService = decision.resetManagedService;
    await tx
      .update(repositoryProcessingJobs)
      .set({
        status: "pending",
        availableAt: new Date(now.getTime() + delaySeconds * 1_000),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: decision.code,
        lastErrorMessage: decision.message,
        ...(restartManagedService
          ? {
              metrics: resetManagedServiceMetrics(
                job.metrics,
                restartManagedService
              ),
              startedAt: now,
            }
          : {}),
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(repositoryProcessingJobs.id, job.id));
    return { action: "retry", delaySeconds };
  }, "contentProcessor.recordFailure");
}
