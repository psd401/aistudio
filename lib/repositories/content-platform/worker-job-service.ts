import { and, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
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

export interface RepositoryProcessingTargetLifecycle {
  repositoryLifecycleStatus: "active" | "expired" | "deleting" | "deleted";
  repositoryExpiresAt: Date | null;
  itemLifecycleStatus:
    | "active"
    | "unavailable"
    | "expired"
    | "deleting"
    | "deleted";
  currentVersionId: string | null;
}

export function isRepositoryProcessingTargetActive(
  target: RepositoryProcessingTargetLifecycle,
  itemVersionId: string,
  now = new Date()
): boolean {
  const expiresAt = target.repositoryExpiresAt?.getTime();
  return (
    target.repositoryLifecycleStatus === "active" &&
    (expiresAt === undefined ||
      (!Number.isNaN(expiresAt) && expiresAt > now.getTime())) &&
    target.itemLifecycleStatus === "active" &&
    target.currentVersionId === itemVersionId
  );
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

export interface RepositoryProcessingMutationCoordinates {
  repositoryId: number;
  itemId: number;
}

/**
 * Rows written before bdaInvocationState was introduced are fail-closed: an
 * ARN without an explicit terminal marker may still be writing S3 output.
 */
export function isBdaInvocationExternallyActive(
  metrics: RepositoryProcessingMetrics
): boolean {
  return Boolean(
    metrics.bdaInvocationArn &&
      metrics.bdaInvocationState !== "terminal"
  );
}

interface RepositoryProcessingMutationLockTransaction {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * Resolve immutable coordinates without locks, then acquire every lifecycle
 * mutation lock in the global repository -> item -> job -> version order.
 * Deletion, claim, publication, security blocks, and retry recording therefore
 * cannot form a job-first/item-first cycle.
 */
export async function lockRepositoryProcessingMutationTarget(
  tx: RepositoryProcessingMutationLockTransaction,
  message: RepositoryProcessingJobMessage
): Promise<RepositoryProcessingMutationCoordinates | null> {
  const coordinates = toPgRows<{
    repository_id: number;
    item_id: number;
  }>(
    await tx.execute(sql`
      SELECT item.repository_id, item.id AS item_id
      FROM repository_processing_jobs job
      JOIN repository_item_versions version
        ON version.id = job.item_version_id
      JOIN repository_items item ON item.id = version.item_id
      WHERE job.id = ${message.jobId}
        AND job.item_version_id = ${message.itemVersionId}
        AND version.id = ${message.itemVersionId}
      LIMIT 1
    `)
  )[0];
  if (!coordinates) return null;

  const repository = toPgRows<{ id: number }>(
    await tx.execute(sql`
      SELECT repository.id
      FROM knowledge_repositories repository
      WHERE repository.id = ${coordinates.repository_id}
      FOR UPDATE OF repository
    `)
  )[0];
  if (!repository) return null;

  const item = toPgRows<{ id: number }>(
    await tx.execute(sql`
      SELECT item.id
      FROM repository_items item
      WHERE item.id = ${coordinates.item_id}
        AND item.repository_id = ${coordinates.repository_id}
      FOR UPDATE OF item
    `)
  )[0];
  if (!item) return null;

  const job = toPgRows<{ id: string }>(
    await tx.execute(sql`
      SELECT job.id
      FROM repository_processing_jobs job
      WHERE job.id = ${message.jobId}
        AND job.item_version_id = ${message.itemVersionId}
      FOR UPDATE OF job
    `)
  )[0];
  if (!job) return null;

  const version = toPgRows<{ id: string }>(
    await tx.execute(sql`
      SELECT version.id
      FROM repository_item_versions version
      WHERE version.id = ${message.itemVersionId}
        AND version.item_id = ${coordinates.item_id}
      FOR UPDATE OF version
    `)
  )[0];
  if (!version) return null;

  return {
    repositoryId: Number(coordinates.repository_id),
    itemId: Number(coordinates.item_id),
  };
}

/** Remove every identifier/output that belongs to one failed provider run. */
export function resetManagedServiceMetrics(
  source: RepositoryProcessingMetrics,
  provider: RestartableManagedService
): RepositoryProcessingMetrics {
  const metrics = { ...source };
  delete metrics.waitReason;
  delete metrics.waitStartedAt;
  delete metrics.waitDeadlineExceededAt;
  if (provider === "textract") {
    delete metrics.textractJobId;
    delete metrics.textractObjectKey;
    return metrics;
  }
  delete metrics.bdaInvocationArn;
  delete metrics.bdaInvocationState;
  delete metrics.bdaTerminalStatus;
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
    const coordinates = await lockRepositoryProcessingMutationTarget(
      tx,
      message
    );
    if (!coordinates) {
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
          eq(repositoryItems.id, coordinates.itemId),
          eq(repositoryItems.currentVersionId, message.itemVersionId)
        )
      );
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
      const [coordinates] = await tx
        .select({
          itemId: repositoryItemVersions.itemId,
          repositoryId: repositoryItems.repositoryId,
        })
        .from(repositoryItemVersions)
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.id, repositoryItemVersions.itemId)
        )
        .where(eq(repositoryItemVersions.id, message.itemVersionId))
        .limit(1);
      if (!coordinates) {
        throw new Error("Processing job does not match its item version");
      }

      // All canonical producers lock repository -> item -> job. Deletion uses
      // the same order, so a worker either becomes durably running before a
      // delete (which then waits) or observes the deleting fence and no-ops.
      const [repository] = await tx
        .select({
          lifecycleStatus: knowledgeRepositories.lifecycleStatus,
          expiresAt: knowledgeRepositories.expiresAt,
        })
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, coordinates.repositoryId))
        .limit(1)
        .for("update");
      const [item] = await tx
        .select({
          lifecycleStatus: repositoryItems.lifecycleStatus,
          currentVersionId: repositoryItems.currentVersionId,
        })
        .from(repositoryItems)
        .where(
          and(
            eq(repositoryItems.id, coordinates.itemId),
            eq(repositoryItems.repositoryId, coordinates.repositoryId)
          )
        )
        .limit(1)
        .for("update");
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
        !repository ||
        !item ||
        !isRepositoryProcessingTargetActive(
          {
            repositoryLifecycleStatus: repository.lifecycleStatus,
            repositoryExpiresAt: repository.expiresAt,
            itemLifecycleStatus: item.lifecycleStatus,
            currentVersionId: item.currentVersionId,
          },
          message.itemVersionId,
          now
        )
      ) {
        if (job.status === "pending" || job.status === "queued") {
          await tx
            .update(repositoryProcessingJobs)
            .set({
              status: "cancelled",
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: "CONTENT_TARGET_INACTIVE",
              lastErrorMessage:
                "Repository processing target is no longer active",
              finishedAt: now,
              updatedAt: now,
            })
            .where(eq(repositoryProcessingJobs.id, job.id));
        }
        return null;
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
    const coordinates = await lockRepositoryProcessingMutationTarget(
      tx,
      message
    );
    if (!coordinates) return { action: "ignore" };

    const [job] = await tx
      .select()
      .from(repositoryProcessingJobs)
      .where(eq(repositoryProcessingJobs.id, message.jobId))
      .limit(1);
    if (
      !job ||
      job.itemVersionId !== message.itemVersionId ||
      job.status === "succeeded" ||
      job.status === "cancelled"
    ) {
      return { action: "ignore" };
    }

    // A BDA invocation without an explicit terminal status may still publish
    // S3 output. Never abandon that external writer because a status request
    // failed or the normal processing retry budget elapsed. Returning the
    // claimed attempt keeps the durable job sweep eligible to reconcile it.
    const activeBdaInvocation = isBdaInvocationExternallyActive(job.metrics);
    const terminal =
      !activeBdaInvocation &&
      (decision.terminal || job.attempt >= job.maxAttempts);
    if (terminal) {
      const code = decision.terminal
        ? decision.code
        : "RETRY_BUDGET_EXHAUSTED";
      const terminalMetrics =
        job.metrics.bdaInvocationArn &&
        job.metrics.bdaInvocationState === "terminal"
          ? resetManagedServiceMetrics(
              job.metrics,
              "bedrock-data-automation"
            )
          : job.metrics;
      await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "failed",
          attempt: job.maxAttempts,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          lastErrorMessage: decision.message,
          metrics: terminalMetrics,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(repositoryProcessingJobs.id, job.id));

      const [version] = await tx
        .select({
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
              eq(repositoryItems.id, coordinates.itemId),
              eq(repositoryItems.currentVersionId, message.itemVersionId)
            )
          );
      }
      return { action: "terminal", code };
    }

    const delaySeconds = options.retryDelaySeconds(job.attempt);
    const restartManagedService = activeBdaInvocation
      ? undefined
      : decision.resetManagedService;
    await tx
      .update(repositoryProcessingJobs)
      .set({
        status: "pending",
        ...(activeBdaInvocation
          ? { attempt: Math.max(0, job.attempt - 1) }
          : {}),
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
