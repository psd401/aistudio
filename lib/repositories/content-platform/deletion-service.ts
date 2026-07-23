import { and, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryItems,
} from "@/lib/db/schema";
import type { RepositoryStorageItem } from "./storage-cleanup";
import { REPOSITORY_UPLOAD_SETTLE_MS } from "./upload-state";

export type RepositoryDeletionBlocker =
  | "repository-not-deletable"
  | "item-not-deletable"
  | "unexpired-upload"
  | "running-processing-job";

/**
 * A deletion blocker is deliberately retryable. In particular, presigned S3
 * requests cannot be revoked after issuance, so deletion must wait until every
 * repository-bound URL has expired rather than only changing the session row.
 */
export class RepositoryDeletionBlockedError extends Error {
  constructor(
    readonly blocker: RepositoryDeletionBlocker,
    message: string
  ) {
    super(message);
    this.name = "RepositoryDeletionBlockedError";
  }
}

interface LockedRepository {
  id: number;
  repository_kind: "durable" | "ephemeral" | "system";
  lifecycle_status: "active" | "expired" | "deleting" | "deleted";
  expires_at: Date | string | null;
}

interface LockedItem {
  id: number;
  repository_id: number;
  type: string;
  source: string;
  lifecycle_status:
    | "active"
    | "unavailable"
    | "expired"
    | "deleting"
    | "deleted";
}

function asDate(value: Date | string | null): Date | null {
  if (value == null || value instanceof Date) return value;
  return new Date(value);
}

function assertRepositoryCanEnterDeletion(
  repository: LockedRepository | undefined,
  now: Date,
  allowDeletingRetry: boolean
): asserts repository is LockedRepository {
  const expiresAt = asDate(repository?.expires_at ?? null);
  const activeAndCurrent =
    repository?.lifecycle_status === "active" &&
    (!expiresAt ||
      (!Number.isNaN(expiresAt.getTime()) &&
        expiresAt.getTime() > now.getTime()));
  const retrying =
    allowDeletingRetry && repository?.lifecycle_status === "deleting";

  if (
    !repository ||
    repository.repository_kind !== "durable" ||
    (!activeAndCurrent && !retrying)
  ) {
    throw new RepositoryDeletionBlockedError(
      "repository-not-deletable",
      "Repository is not an active user-managed durable repository"
    );
  }
}

function assertItemCanEnterDeletion(
  item: LockedItem | undefined
): asserts item is LockedItem {
  if (
    !item ||
    (item.lifecycle_status !== "active" &&
      item.lifecycle_status !== "deleting")
  ) {
    throw new RepositoryDeletionBlockedError(
      "item-not-deletable",
      "Repository item is not active or awaiting deletion retry"
    );
  }
}

function assertNoUploadOrWorkerBlockers(input: {
  uploadSessionId?: string;
  runningJobId?: string;
}): void {
  if (input.uploadSessionId) {
    throw new RepositoryDeletionBlockedError(
      "unexpired-upload",
      "Repository deletion is waiting for an issued upload URL to expire and settle"
    );
  }
  if (input.runningJobId) {
    throw new RepositoryDeletionBlockedError(
      "running-processing-job",
      "Repository deletion is waiting for active content processing to finish"
    );
  }
}

/**
 * Fence every producer before repository storage is swept.
 *
 * Lock order is repository -> items -> upload sessions/jobs. Upload
 * reservation/completion, worker claim, and publication use the same leading
 * repository lock. Once this transaction commits, no new canonical object
 * producer can start and pending work has been cancelled. A cleanup failure
 * intentionally leaves `deleting` in place; calling this function again is the
 * supported idempotent retry path.
 */
export async function beginRepositoryDeletion(
  repositoryId: number,
  now = new Date()
): Promise<RepositoryStorageItem[]> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new RepositoryDeletionBlockedError(
      "repository-not-deletable",
      "A valid repository id is required"
    );
  }

  return executeTransaction(
    async (tx) => {
      const repositoryRows = toPgRows<LockedRepository>(
        await tx.execute(sql`
          SELECT
            repository.id,
            repository.repository_kind,
            repository.lifecycle_status,
            repository.expires_at
          FROM knowledge_repositories repository
          WHERE repository.id = ${repositoryId}
          FOR UPDATE OF repository
        `)
      );
      const repository = repositoryRows[0];
      assertRepositoryCanEnterDeletion(repository, now, true);

      const items = toPgRows<LockedItem>(
        await tx.execute(sql`
          SELECT
            item.id,
            item.repository_id,
            item.type,
            item.source,
            item.lifecycle_status
          FROM repository_items item
          WHERE item.repository_id = ${repositoryId}
          ORDER BY item.id
          FOR UPDATE OF item
        `)
      );

      // Include every status, even completed/aborted. Until expires_at passes,
      // a previously returned single-part PUT can still be replayed after a
      // prefix sweep and recreate the object.
      const settledBefore = new Date(
        now.getTime() - REPOSITORY_UPLOAD_SETTLE_MS
      );
      const uploadRows = toPgRows<{ id: string }>(
        await tx.execute(sql`
          SELECT session.id
          FROM repository_upload_sessions session
          WHERE session.repository_id = ${repositoryId}
            AND session.expires_at >
              ${settledBefore.toISOString()}::timestamptz
          ORDER BY session.expires_at, session.id
          LIMIT 1
          FOR UPDATE OF session
        `)
      );
      const runningJobRows = toPgRows<{ id: string }>(
        await tx.execute(sql`
          SELECT job.id
          FROM repository_processing_jobs job
          JOIN repository_item_versions version
            ON version.id = job.item_version_id
          JOIN repository_items item
            ON item.id = version.item_id
          WHERE item.repository_id = ${repositoryId}
            AND (
              job.status = 'running'
              OR (
                job.status IN ('pending', 'queued')
                AND job.metrics ? 'textractJobId'
              )
              OR (
                job.metrics ? 'bdaInvocationArn'
                AND COALESCE(
                  job.metrics ->> 'bdaInvocationState',
                  'active'
                ) <> 'terminal'
              )
            )
          ORDER BY job.id
          LIMIT 1
          FOR UPDATE OF job
        `)
      );
      assertNoUploadOrWorkerBlockers({
        uploadSessionId: uploadRows[0]?.id,
        runningJobId: runningJobRows[0]?.id,
      });

      await tx.execute(sql`
        UPDATE repository_processing_jobs job
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = 'CONTENT_DELETION_CANCELLED',
            last_error_message = 'Cancelled before repository deletion',
            finished_at = ${now.toISOString()}::timestamptz,
            updated_at = ${now.toISOString()}::timestamptz
        FROM repository_item_versions version, repository_items item
        WHERE job.item_version_id = version.id
          AND version.item_id = item.id
          AND item.repository_id = ${repositoryId}
          AND job.status IN ('pending', 'queued')
      `);
      await tx.execute(sql`
        UPDATE repository_item_versions version
        SET processing_status = 'cancelled'
        FROM repository_items item
        WHERE version.item_id = item.id
          AND item.repository_id = ${repositoryId}
          AND version.processing_status IN ('pending', 'processing')
      `);
      await tx.execute(sql`
        UPDATE repository_items item
        SET lifecycle_status = 'deleting',
            processing_status = CASE
              WHEN item.processing_status IN ('pending', 'processing')
                THEN 'cancelled'
              ELSE item.processing_status
            END,
            updated_at = ${now.toISOString()}::timestamptz
        WHERE item.repository_id = ${repositoryId}
      `);
      await tx.execute(sql`
        UPDATE knowledge_repositories repository
        SET lifecycle_status = 'deleting',
            updated_at = ${now.toISOString()}::timestamptz
        WHERE repository.id = ${repositoryId}
      `);

      return items.map((item) => ({
        id: Number(item.id),
        repositoryId: Number(item.repository_id),
        type: item.type,
        source: item.source,
      }));
    },
    "contentPlatform.beginRepositoryDeletion"
  );
}

/**
 * Fence one item while keeping its repository available. Repository locking
 * also serializes this operation with generation activation, which may publish
 * a generation containing the item after its processor job has succeeded.
 */
export async function beginRepositoryItemDeletion(
  input: { repositoryId: number; itemId: number },
  now = new Date()
): Promise<RepositoryStorageItem> {
  if (
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId <= 0 ||
    !Number.isSafeInteger(input.itemId) ||
    input.itemId <= 0
  ) {
    throw new RepositoryDeletionBlockedError(
      "item-not-deletable",
      "Valid repository and item ids are required"
    );
  }

  return executeTransaction(
    async (tx) => {
      const repositoryRows = toPgRows<LockedRepository>(
        await tx.execute(sql`
          SELECT
            repository.id,
            repository.repository_kind,
            repository.lifecycle_status,
            repository.expires_at
          FROM knowledge_repositories repository
          WHERE repository.id = ${input.repositoryId}
          FOR UPDATE OF repository
        `)
      );
      const repository = repositoryRows[0];
      // An item retry is allowed while the item is deleting, but never after a
      // whole-repository delete has fenced the parent.
      assertRepositoryCanEnterDeletion(repository, now, false);

      const itemRows = toPgRows<LockedItem>(
        await tx.execute(sql`
          SELECT
            item.id,
            item.repository_id,
            item.type,
            item.source,
            item.lifecycle_status
          FROM repository_items item
          WHERE item.id = ${input.itemId}
            AND item.repository_id = ${input.repositoryId}
          FOR UPDATE OF item
        `)
      );
      const item = itemRows[0];
      assertItemCanEnterDeletion(item);

      const uploadRows = toPgRows<{ id: string }>(
        // Match the lifecycle service's delayed final sweep. A request accepted
        // just before URL expiry may still be transferring after expires_at.
        await tx.execute(sql`
          SELECT session.id
          FROM repository_upload_sessions session
          JOIN repository_item_versions version
            ON version.id = session.item_version_id
          WHERE version.item_id = ${input.itemId}
            AND session.expires_at >
              ${new Date(
                now.getTime() - REPOSITORY_UPLOAD_SETTLE_MS
              ).toISOString()}::timestamptz
          ORDER BY session.expires_at, session.id
          LIMIT 1
          FOR UPDATE OF session
        `)
      );
      const runningJobRows = toPgRows<{ id: string }>(
        await tx.execute(sql`
          SELECT job.id
          FROM repository_processing_jobs job
          JOIN repository_item_versions version
            ON version.id = job.item_version_id
          WHERE version.item_id = ${input.itemId}
            AND (
              job.status = 'running'
              OR (
                job.status IN ('pending', 'queued')
                AND job.metrics ? 'textractJobId'
              )
              OR (
                job.metrics ? 'bdaInvocationArn'
                AND COALESCE(
                  job.metrics ->> 'bdaInvocationState',
                  'active'
                ) <> 'terminal'
              )
            )
          ORDER BY job.id
          LIMIT 1
          FOR UPDATE OF job
        `)
      );
      assertNoUploadOrWorkerBlockers({
        uploadSessionId: uploadRows[0]?.id,
        runningJobId: runningJobRows[0]?.id,
      });

      await tx.execute(sql`
        UPDATE repository_processing_jobs job
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = 'CONTENT_DELETION_CANCELLED',
            last_error_message = 'Cancelled before repository item deletion',
            finished_at = ${now.toISOString()}::timestamptz,
            updated_at = ${now.toISOString()}::timestamptz
        FROM repository_item_versions version
        WHERE job.item_version_id = version.id
          AND version.item_id = ${input.itemId}
          AND job.status IN ('pending', 'queued')
      `);
      await tx.execute(sql`
        UPDATE repository_item_versions version
        SET processing_status = 'cancelled'
        WHERE version.item_id = ${input.itemId}
          AND version.processing_status IN ('pending', 'processing')
      `);
      await tx.execute(sql`
        UPDATE repository_items item
        SET lifecycle_status = 'deleting',
            processing_status = CASE
              WHEN item.processing_status IN ('pending', 'processing')
                THEN 'cancelled'
              ELSE item.processing_status
            END,
            updated_at = ${now.toISOString()}::timestamptz
        WHERE item.id = ${input.itemId}
      `);

      return {
        id: Number(item.id),
        repositoryId: Number(item.repository_id),
        type: item.type,
        source: item.source,
      };
    },
    "contentPlatform.beginRepositoryItemDeletion"
  );
}

export async function finalizeRepositoryDeletion(
  repositoryId: number
): Promise<boolean> {
  const deleted = await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(
          and(
            eq(knowledgeRepositories.id, repositoryId),
            eq(knowledgeRepositories.lifecycleStatus, "deleting")
          )
        )
        .returning({ id: knowledgeRepositories.id }),
    "contentPlatform.finalizeRepositoryDeletion"
  );
  return deleted.length === 1;
}

export async function finalizeRepositoryItemDeletion(
  itemId: number
): Promise<boolean> {
  const deleted = await executeQuery(
    (db) =>
      db
        .delete(repositoryItems)
        .where(
          and(
            eq(repositoryItems.id, itemId),
            eq(repositoryItems.lifecycleStatus, "deleting")
          )
        )
        .returning({ id: repositoryItems.id }),
    "contentPlatform.finalizeRepositoryItemDeletion"
  );
  return deleted.length === 1;
}
