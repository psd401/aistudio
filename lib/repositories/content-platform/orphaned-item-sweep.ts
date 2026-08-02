import { sql } from "drizzle-orm";
import {
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";

export const ORPHANED_ITEM_SWEEP_MINUTES = 60;
export const ORPHANED_ITEM_SWEEP_BATCH = 100;
export const ORPHANED_ITEM_FAILURE_MESSAGE =
  "Content processing never started. Retry this item.";

export interface FailOrphanedRepositoryItemsOptions {
  /** Testable clock; production always uses the current time. */
  now?: Date;
  /** Test override; production always uses the exported minimum age. */
  minimumAgeMinutes?: number;
  /** Test override; production always uses the exported batch size. */
  batchSize?: number;
}

interface FailedItemRow {
  id: number;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Fail one bounded batch of pre-canonical items whose registration never
 * created a current version or processing job. Locked rows are skipped so
 * overlapping scheduled invocations cannot claim the same item.
 */
export async function failOrphanedRepositoryItems(
  options: FailOrphanedRepositoryItemsOptions = {},
): Promise<{ failed: number }> {
  const now = options.now ?? new Date();
  const minimumAgeMinutes = requirePositiveInteger(
    options.minimumAgeMinutes ?? ORPHANED_ITEM_SWEEP_MINUTES,
    "minimumAgeMinutes",
  );
  const batchSize = requirePositiveInteger(
    options.batchSize ?? ORPHANED_ITEM_SWEEP_BATCH,
    "batchSize",
  );
  const eligibleBefore = new Date(
    now.getTime() - minimumAgeMinutes * 60 * 1_000,
  );

  return executeTransaction(
    async (tx) => {
      const result = await tx.execute(sql`
        UPDATE repository_items item
        SET processing_status = 'failed',
            processing_error = ${ORPHANED_ITEM_FAILURE_MESSAGE},
            updated_at = ${now.toISOString()}::timestamptz
        FROM (
          SELECT candidate.id
          FROM repository_items candidate
          INNER JOIN knowledge_repositories repository
            ON repository.id = candidate.repository_id
          WHERE candidate.lifecycle_status = 'active'
            AND repository.lifecycle_status = 'active'
            AND candidate.processing_status IN (
              'pending',
              'processing',
              'processing_ocr'
            )
            AND candidate.current_version_id IS NULL
            AND candidate.updated_at < ${eligibleBefore.toISOString()}::timestamptz
            AND NOT EXISTS (
              SELECT 1
              FROM repository_item_versions version
              INNER JOIN repository_processing_jobs job
                ON job.item_version_id = version.id
              WHERE version.item_id = candidate.id
            )
          ORDER BY candidate.updated_at, candidate.id
          FOR UPDATE OF candidate SKIP LOCKED
          LIMIT ${batchSize}
        ) selected
        WHERE item.id = selected.id
        RETURNING item.id
      `);
      return { failed: toPgRows<FailedItemRow>(result).length };
    },
    "contentPlatform.failOrphanedRepositoryItems",
  );
}
