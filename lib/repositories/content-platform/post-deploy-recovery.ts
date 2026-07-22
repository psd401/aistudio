import { and, eq, inArray, sql } from "drizzle-orm";
import {
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  repositoryItems,
  repositoryItemVersions,
} from "@/lib/db/schema";
import { CONTENT_PROCESSING_MAX_ATTEMPTS } from "./job-state";

export const POST_DEPLOY_RECOVERY_MARKER =
  "unified-content-runtime-v2" as const;
export const POST_DEPLOY_RECOVERY_BATCH_SIZE = 25;
/** Let every invocation of the previous 15-minute Lambda runtime drain first. */
export const POST_DEPLOY_RECOVERY_GRACE_MINUTES = 20;

export interface ReleasedPostDeployRecoveryJob {
  id: string;
  itemVersionId: string;
}

export interface ReleasePostDeployRecoveryOptions {
  /** Testable clock; production always uses the current time. */
  now?: Date;
  /** Test override; production always uses the exported drain window. */
  graceMinutes?: number;
}

/**
 * Release one bounded batch of jobs quarantined by the database migration.
 *
 * The migration deliberately stores these jobs as `cancelled`, which every old
 * worker treats as terminal even if a stale SQS delivery arrives between stack
 * updates. After a drain window longer than the old Lambda timeout, this function
 * also recovers a marked row whose status was overwritten by an invocation that
 * was already running when the migration committed. It ships with the replacement
 * worker and is therefore the only automatic path that can atomically restore the
 * job/version/item to pending.
 */
export async function releasePostDeployRecoveryJobs(
  options: ReleasePostDeployRecoveryOptions = {}
): Promise<ReleasedPostDeployRecoveryJob[]> {
  const graceMinutes =
    options.graceMinutes ?? POST_DEPLOY_RECOVERY_GRACE_MINUTES;
  const eligibleBefore = new Date(
    (options.now ?? new Date()).getTime() - graceMinutes * 60_000
  ).toISOString();
  return executeTransaction(
    async (tx) => {
      const releasedResult = await tx.execute(sql`
        WITH selected AS (
          SELECT job.id
          FROM repository_processing_jobs job
          JOIN repository_item_versions version
            ON version.id = job.item_version_id
          JOIN repository_items item
            ON item.current_version_id = version.id
          WHERE job.stage = 'inspect'
            AND job.status IN ('cancelled', 'failed', 'pending', 'queued', 'running')
            AND job.metrics ->> 'postDeployRecovery' = ${POST_DEPLOY_RECOVERY_MARKER}
            AND job.updated_at <= ${eligibleBefore}::timestamptz
            AND item.lifecycle_status = 'active'
            AND version.storage_status <> 'blocked'
            AND version.inspection_status <> 'blocked'
            AND version.object_key ~ (
              '^repositories/' || item.repository_id::text ||
              '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/[^/]+$'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM repository_item_chunks active_chunk
              JOIN knowledge_repositories repository
                ON repository.id = item.repository_id
              WHERE active_chunk.item_version_id = version.id
                AND active_chunk.index_generation_id = repository.active_index_generation_id
            )
          ORDER BY job.updated_at, job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT ${POST_DEPLOY_RECOVERY_BATCH_SIZE}
        )
        UPDATE repository_processing_jobs job
        SET status = 'pending',
            attempt = 0,
            max_attempts = ${CONTENT_PROCESSING_MAX_ATTEMPTS},
            available_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            metrics = '{}'::jsonb,
            started_at = NULL,
            finished_at = NULL,
            updated_at = now()
        FROM selected
        WHERE job.id = selected.id
        RETURNING job.id, job.item_version_id
      `);
      const released = toPgRows<{ id: string; item_version_id: string }>(
        releasedResult
      ).map((row) => ({ id: row.id, itemVersionId: row.item_version_id }));
      if (released.length === 0) return [];

      const itemVersionIds = [...new Set(released.map((job) => job.itemVersionId))];
      await tx
        .update(repositoryItemVersions)
        .set({
          storageStatus: "quarantined",
          inspectionStatus: "pending",
          inspectionDetails: {},
          processingStatus: "pending",
        })
        .where(inArray(repositoryItemVersions.id, itemVersionIds));
      await tx
        .update(repositoryItems)
        .set({
          processingStatus: "pending",
          processingError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(repositoryItems.lifecycleStatus, "active"),
            inArray(repositoryItems.currentVersionId, itemVersionIds)
          )
        );

      return released;
    },
    "contentPlatform.releasePostDeployRecoveryJobs"
  );
}
