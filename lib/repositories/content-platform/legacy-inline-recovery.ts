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
} from "@/lib/db/schema";
import { CONTENT_PROCESSING_MAX_ATTEMPTS } from "./job-state";
import { sourceRevisionForObjectKey } from "./ingestion-service";

export const LEGACY_INLINE_RECOVERY_BATCH_SIZE = 10;
export const LEGACY_INLINE_RECOVERY_LEASE_MS = 5 * 60_000;

export interface LegacyInlineTextRecoveryClaim {
  jobId: string;
  itemVersionId: string;
  leaseOwner: string;
  itemId: number;
  repositoryId: number;
  itemName: string;
  content: string;
}

export interface ClaimLegacyInlineTextRecoveryOptions {
  /** Unique per Lambda invocation; fences a late completion after lease expiry. */
  leaseOwner: string;
  now?: Date;
  /** Test/operations scope; production scheduled recovery scans all repositories. */
  repositoryId?: number;
}

/** Claim old inline-text versions whose source was never put in the immutable namespace. */
export async function claimLegacyInlineTextRecoveries(
  options: ClaimLegacyInlineTextRecoveryOptions
): Promise<LegacyInlineTextRecoveryClaim[]> {
  const now = options.now ?? new Date();
  const leaseOwner = options.leaseOwner.trim();
  if (!leaseOwner) {
    throw new Error("Legacy inline recovery requires a unique lease owner");
  }
  const claimed = await executeTransaction(
    (tx) =>
      tx.execute(sql`
        WITH selected AS (
          SELECT
            job.id,
            job.item_version_id,
            item.id AS item_id,
            item.repository_id,
            item.name,
            item.source
          FROM repository_processing_jobs job
          JOIN repository_item_versions version
            ON version.id = job.item_version_id
          JOIN repository_items item
            ON item.current_version_id = version.id
          WHERE job.stage = 'inspect'
            AND job.post_deploy_recovery IS NULL
            AND job.available_at <= ${now.toISOString()}::timestamptz
            AND (
              job.status IN ('pending', 'queued', 'failed', 'cancelled')
              OR (
                job.status = 'running'
                AND job.lease_expires_at <= ${now.toISOString()}::timestamptz
              )
            )
            AND item.lifecycle_status = 'active'
            AND (
              ${options.repositoryId ?? null}::integer IS NULL
              OR item.repository_id = ${options.repositoryId ?? null}::integer
            )
            AND item.type = 'text'
            AND btrim(item.source) <> ''
            AND version.storage_status <> 'blocked'
            AND version.inspection_status <> 'blocked'
            AND NOT (
              version.object_key ~ (
                '^repositories/' || item.repository_id::text ||
                '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[^/]+$'
              )
            )
          ORDER BY job.updated_at, job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT ${LEGACY_INLINE_RECOVERY_BATCH_SIZE}
        )
        UPDATE repository_processing_jobs job
        SET status = 'running',
            lease_owner = ${leaseOwner},
            lease_expires_at = ${new Date(
              now.getTime() + LEGACY_INLINE_RECOVERY_LEASE_MS
            ).toISOString()}::timestamptz,
            updated_at = ${now.toISOString()}::timestamptz
        FROM selected
        WHERE job.id = selected.id
        RETURNING
          job.id,
          selected.item_version_id,
          job.lease_owner,
          selected.item_id,
          selected.repository_id,
          selected.name,
          selected.source
      `),
    "contentPlatform.claimLegacyInlineTextRecoveries"
  );
  return toPgRows<{
    id: string;
    item_version_id: string;
    lease_owner: string;
    item_id: number;
    repository_id: number;
    name: string;
    source: string;
  }>(claimed).map((row) => ({
    jobId: row.id,
    itemVersionId: row.item_version_id,
    leaseOwner: row.lease_owner,
    itemId: row.item_id,
    repositoryId: row.repository_id,
    itemName: row.name,
    content: row.source,
  }));
}

export interface CompleteLegacyInlineTextRecoveryInput {
  claim: LegacyInlineTextRecoveryClaim;
  objectKey: string;
  byteSize: number;
  sha256: string;
  now?: Date;
}

/** Publish the immutable source pointer and reset the existing inspect job atomically. */
export async function completeLegacyInlineTextRecovery(
  input: CompleteLegacyInlineTextRecoveryInput
): Promise<boolean> {
  const leaseOwner = input.claim.leaseOwner;
  const now = input.now ?? new Date();
  return executeTransaction(async (tx) => {
    const [job] = await tx
      .select({
        id: repositoryProcessingJobs.id,
        leaseOwner: repositoryProcessingJobs.leaseOwner,
        itemVersionId: repositoryProcessingJobs.itemVersionId,
        metadata: repositoryItemVersions.metadata,
        active: sql<boolean>`EXISTS (
          SELECT 1
          FROM ${repositoryItemChunks} active_chunk
          JOIN ${knowledgeRepositories} active_repository
            ON active_repository.id = ${repositoryItems.repositoryId}
          WHERE active_chunk.item_version_id = ${repositoryItemVersions.id}
            AND active_chunk.index_generation_id = active_repository.active_index_generation_id
            AND ${repositoryItems.currentVersionId} = ${repositoryItemVersions.id}
            AND ${repositoryItems.lifecycleStatus} = 'active'
        )`,
      })
      .from(repositoryProcessingJobs)
      .innerJoin(
        repositoryItemVersions,
        eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
      )
      .innerJoin(
        repositoryItems,
        and(
          eq(repositoryItems.id, input.claim.itemId),
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
      )
      .where(eq(repositoryProcessingJobs.id, input.claim.jobId))
      .limit(1)
      .for("update");
    if (
      !job ||
      job.itemVersionId !== input.claim.itemVersionId ||
      job.leaseOwner !== leaseOwner
    ) {
      return false;
    }

    await tx
      .update(repositoryItemVersions)
      .set({
        sourceKind: "text",
        sourceRevision: sourceRevisionForObjectKey(input.objectKey),
        objectKey: input.objectKey,
        byteSize: input.byteSize,
        sha256: input.sha256,
        declaredContentType: "text/plain",
        metadata: {
          ...(job.metadata ?? {}),
          originalFileName: `inline-${input.claim.itemId}.txt`,
          recoveredLegacyInlineSource: true,
        },
        ...(job.active
          ? {}
          : {
              storageStatus: "quarantined" as const,
              inspectionStatus: "pending" as const,
              inspectionDetails: {},
              processingStatus: "pending" as const,
            }),
      })
      .where(eq(repositoryItemVersions.id, input.claim.itemVersionId));
    await tx
      .update(repositoryProcessingJobs)
      .set({
        status: "pending",
        attempt: 0,
        maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        metrics: {},
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(repositoryProcessingJobs.id, input.claim.jobId));
    await tx
      .update(repositoryItems)
      .set({
        source: input.objectKey,
        ...(job.active
          ? {}
          : { processingStatus: "pending" as const, processingError: null }),
        updatedAt: now,
      })
      .where(
        and(
          eq(repositoryItems.id, input.claim.itemId),
          eq(repositoryItems.currentVersionId, input.claim.itemVersionId)
        )
      );
    return true;
  }, "contentPlatform.completeLegacyInlineTextRecovery");
}

/** Release a failed S3 migration without making the noncanonical job dispatchable. */
export async function failLegacyInlineTextRecovery(
  claim: LegacyInlineTextRecoveryClaim,
  errorMessage: string,
  now = new Date()
): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          status: "failed",
          availableAt: new Date(now.getTime() + 60_000),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: "LEGACY_INLINE_SOURCE_RECOVERY_FAILED",
          lastErrorMessage: errorMessage.slice(0, 4_000),
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(repositoryProcessingJobs.id, claim.jobId),
            eq(repositoryProcessingJobs.itemVersionId, claim.itemVersionId),
            eq(repositoryProcessingJobs.leaseOwner, claim.leaseOwner)
          )
        ),
    "contentPlatform.failLegacyInlineTextRecovery"
  );
}
