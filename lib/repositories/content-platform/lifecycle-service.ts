import { and, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryAccess,
  repositoryItems,
} from "@/lib/db/schema";
import {
  getContentPlatformConfig,
  type ContentPlatformConfig,
} from "./config";
import {
  deleteRepositoryItemStorage,
  type RepositoryStorageItem,
} from "./storage-cleanup";
import { deleteRepositoryObjectVersionsByPrefix } from "@/lib/aws/s3-client";
import { REPOSITORY_UPLOAD_SETTLE_MS } from "./upload-state";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NEXUS_LIFECYCLE_BATCH_SIZE = 10;
/** Longer than the unified-content Lambda timeout, so a live purge is not stolen. */
export const NEXUS_PURGE_LEASE_MS = 20 * 60 * 1000;

export interface NexusRepositoryPurgeClaim {
  repositoryId: number;
  claimedAt: Date;
}

export interface NexusRepositoryLifecycleResult {
  expired: number;
  purged: number;
}

export interface NexusRepositoryLifecycleOptions {
  now?: Date;
  deletionGraceDays?: number;
  batchSize?: number;
}

export interface NexusRepositoryLifecycleDependencies {
  getConfig(): Promise<Pick<ContentPlatformConfig, "deletionGraceDays">>;
  expire(now: Date): Promise<number>;
  claim(input: {
    now: Date;
    graceEndsBefore: Date;
    staleLeaseBefore: Date;
    batchSize: number;
  }): Promise<NexusRepositoryPurgeClaim[]>;
  listItems(repositoryId: number): Promise<RepositoryStorageItem[]>;
  deleteItemStorage(item: RepositoryStorageItem): Promise<void>;
  deleteRepositoryStorage(repositoryId: number): Promise<void>;
  finalize(claim: NexusRepositoryPurgeClaim): Promise<boolean>;
  retainDeletingForRetry(
    claim: NexusRepositoryPurgeClaim,
    now: Date
  ): Promise<void>;
}

function assertLifecycleBounds(deletionGraceDays: number, batchSize: number): void {
  if (
    !Number.isSafeInteger(deletionGraceDays) ||
    deletionGraceDays < 1 ||
    deletionGraceDays > 365
  ) {
    throw new Error("Content deletion grace must be between 1 and 365 days");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Nexus lifecycle batch size must be between 1 and 100");
  }
}

export const defaultNexusRepositoryLifecycleDependencies: NexusRepositoryLifecycleDependencies = {
  async getConfig() {
    const config = await getContentPlatformConfig();
    return { deletionGraceDays: config.deletionGraceDays };
  },

  async expire(now) {
    const result = await executeQuery(
      (db) =>
        db
          .update(knowledgeRepositories)
          .set({ lifecycleStatus: "expired", updatedAt: now })
          .where(
            and(
              eq(knowledgeRepositories.repositoryKind, "ephemeral"),
              eq(knowledgeRepositories.lifecycleStatus, "active"),
              sql`${knowledgeRepositories.expiresAt} IS NOT NULL`,
              sql`${knowledgeRepositories.expiresAt} <= ${now.toISOString()}::timestamptz`
            )
          )
          .returning({ id: knowledgeRepositories.id }),
      "contentPlatform.expireNexusRepositories"
    );
    return result.length;
  },

  async claim(input) {
    const result = await executeTransaction(
      async (tx) => {
        // The repository row is the producer fence shared with upload
        // reservation/completion, worker claim, publication and generation
        // activation. SKIP LOCKED lets a live producer finish; an unexpired URL
        // or managed-service producer makes this repository ineligible until a
        // later lifecycle run.
        const selected = toPgRows<{ id: number }>(
          await tx.execute(sql`
            SELECT repository.id
            FROM knowledge_repositories repository
            WHERE repository.repository_kind = 'ephemeral'
              AND (
                (
                  repository.lifecycle_status = 'expired'
                  AND repository.expires_at <=
                    ${input.graceEndsBefore.toISOString()}::timestamptz
                )
                OR (
                  repository.lifecycle_status = 'deleting'
                  AND repository.updated_at <=
                    ${input.staleLeaseBefore.toISOString()}::timestamptz
                )
              )
            ORDER BY repository.expires_at, repository.id
            FOR UPDATE OF repository SKIP LOCKED
            LIMIT ${input.batchSize}
          `)
        );
        if (selected.length === 0) return [];
        const ids = sql.join(
          selected.map((repository) => sql`${repository.id}`),
          sql`, `
        );

        await tx.execute(sql`
          SELECT item.id
          FROM repository_items item
          WHERE item.repository_id IN (${ids})
          ORDER BY item.repository_id, item.id
          FOR UPDATE OF item
        `);

        // Re-evaluate producer blockers in fresh statements after the
        // repository locks. A reservation/completion/worker that committed
        // while the candidate SELECT was waiting is now visible, while no new
        // producer can cross the repository fence. Lock order remains
        // repository -> items -> sessions/jobs for every lifecycle path.
        const uploadBlockers = toPgRows<{
          repository_id: number;
          id: string;
        }>(
          await tx.execute(sql`
            SELECT session.repository_id, session.id
            FROM repository_upload_sessions session
            WHERE session.repository_id IN (${ids})
              AND session.expires_at >
                ${new Date(
                  input.now.getTime() - REPOSITORY_UPLOAD_SETTLE_MS
                ).toISOString()}::timestamptz
            ORDER BY session.repository_id, session.expires_at, session.id
            FOR UPDATE OF session
          `)
        );
        const jobBlockers = toPgRows<{
          repository_id: number;
          id: string;
        }>(
          await tx.execute(sql`
            SELECT item.repository_id, job.id
            FROM repository_processing_jobs job
            JOIN repository_item_versions version
              ON version.id = job.item_version_id
            JOIN repository_items item ON item.id = version.item_id
            WHERE item.repository_id IN (${ids})
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
            ORDER BY item.repository_id, job.id
            FOR UPDATE OF job
          `)
        );
        const blockedRepositoryIds = new Set([
          ...uploadBlockers.map((blocker) => Number(blocker.repository_id)),
          ...jobBlockers.map((blocker) => Number(blocker.repository_id)),
        ]);
        const eligible = selected.filter(
          (repository) => !blockedRepositoryIds.has(Number(repository.id))
        );
        if (eligible.length === 0) return [];
        const eligibleIds = sql.join(
          eligible.map((repository) => sql`${repository.id}`),
          sql`, `
        );
        await tx.execute(sql`
          UPDATE repository_processing_jobs job
          SET status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error_code = 'CONTENT_DELETION_CANCELLED',
              last_error_message = 'Cancelled before ephemeral repository purge',
              finished_at = ${input.now.toISOString()}::timestamptz,
              updated_at = ${input.now.toISOString()}::timestamptz
          FROM repository_item_versions version, repository_items item
          WHERE job.item_version_id = version.id
            AND version.item_id = item.id
            AND item.repository_id IN (${eligibleIds})
            AND job.status IN ('pending', 'queued')
        `);
        await tx.execute(sql`
          UPDATE repository_item_versions version
          SET processing_status = 'cancelled'
          FROM repository_items item
          WHERE version.item_id = item.id
            AND item.repository_id IN (${eligibleIds})
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
              updated_at = ${input.now.toISOString()}::timestamptz
          WHERE item.repository_id IN (${eligibleIds})
        `);
        return tx.execute(sql`
          UPDATE knowledge_repositories repository
          SET lifecycle_status = 'deleting',
              updated_at = ${input.now.toISOString()}::timestamptz
          WHERE repository.id IN (${eligibleIds})
          RETURNING repository.id, repository.updated_at
        `);
      },
      "contentPlatform.claimNexusRepositoryPurges"
    );
    return toPgRows<{ id: number; updated_at: Date | string }>(result).map(
      (row) => ({
        repositoryId: Number(row.id),
        claimedAt:
          row.updated_at instanceof Date
            ? row.updated_at
            : new Date(row.updated_at),
      })
    );
  },

  listItems(repositoryId) {
    return executeQuery(
      (db) =>
        db
          .select({
            id: repositoryItems.id,
            repositoryId: repositoryItems.repositoryId,
            type: repositoryItems.type,
            source: repositoryItems.source,
          })
          .from(repositoryItems)
          .where(eq(repositoryItems.repositoryId, repositoryId)),
      "contentPlatform.listNexusRepositoryPurgeItems"
    );
  },

  async deleteItemStorage(item) {
    await deleteRepositoryItemStorage(item);
  },

  async deleteRepositoryStorage(repositoryId) {
    await deleteRepositoryObjectVersionsByPrefix(
      `repositories/${repositoryId}/`
    );
  },

  async finalize(claim) {
    return executeTransaction(
      async (tx) => {
        const [repository] = await tx
          .select({ id: knowledgeRepositories.id })
          .from(knowledgeRepositories)
          .where(
            and(
              eq(knowledgeRepositories.id, claim.repositoryId),
              eq(knowledgeRepositories.repositoryKind, "ephemeral"),
              eq(knowledgeRepositories.lifecycleStatus, "deleting"),
              eq(knowledgeRepositories.updatedAt, claim.claimedAt)
            )
          )
          .limit(1)
          .for("update");
        if (!repository) return false;

        // Ephemeral repositories should never have grants, but remove any
        // anomalous rows before the repository delete so the non-cascading
        // legacy repository_access FK cannot strand lifecycle cleanup.
        await tx
          .delete(repositoryAccess)
          .where(eq(repositoryAccess.repositoryId, claim.repositoryId));
        const deleted = await tx
          .delete(knowledgeRepositories)
          .where(eq(knowledgeRepositories.id, claim.repositoryId))
          .returning({ id: knowledgeRepositories.id });
        return deleted.length === 1;
      },
      "contentPlatform.finalizeNexusRepositoryPurge"
    );
  },

  async retainDeletingForRetry(claim, now) {
    await executeQuery(
      (db) =>
        db
          .update(knowledgeRepositories)
          // A failed purge may already have removed some source or artifact
          // objects. Keep the repository behind the deleting fence so it can
          // never be promoted as an intact expired repository. Refreshing the
          // lease timestamp lets the stale-deleting claim path retry the
          // idempotent purge after the worker lease interval.
          .set({ updatedAt: now })
          .where(
            and(
              eq(knowledgeRepositories.id, claim.repositoryId),
              eq(knowledgeRepositories.repositoryKind, "ephemeral"),
              eq(knowledgeRepositories.lifecycleStatus, "deleting"),
              eq(knowledgeRepositories.updatedAt, claim.claimedAt)
            )
          ),
      "contentPlatform.retainDeletingNexusRepositoryPurge"
    );
  },
};

/**
 * Enforce private Nexus repository retention in two phases: retrieval is
 * disabled at expiry, then source/artifact objects are deleted after the grace
 * window before database rows are removed. Failed or interrupted purges remain
 * fenced as deleting and are safely reclaimed after their lease because S3
 * deletion is idempotent.
 */
export async function enforceNexusRepositoryLifecycle(
  options: NexusRepositoryLifecycleOptions = {},
  dependencies: NexusRepositoryLifecycleDependencies =
    defaultNexusRepositoryLifecycleDependencies
): Promise<NexusRepositoryLifecycleResult> {
  const now = options.now ?? new Date();
  const configured = await dependencies.getConfig();
  const deletionGraceDays =
    options.deletionGraceDays ?? configured.deletionGraceDays;
  const batchSize = options.batchSize ?? NEXUS_LIFECYCLE_BATCH_SIZE;
  assertLifecycleBounds(deletionGraceDays, batchSize);

  const expired = await dependencies.expire(now);
  const claims = await dependencies.claim({
    now,
    graceEndsBefore: new Date(now.getTime() - deletionGraceDays * DAY_MS),
    staleLeaseBefore: new Date(now.getTime() - NEXUS_PURGE_LEASE_MS),
    batchSize,
  });

  let purged = 0;
  const failures: Error[] = [];
  for (const claim of claims) {
    try {
      const items = await dependencies.listItems(claim.repositoryId);
      for (const item of items) {
        await dependencies.deleteItemStorage(item);
      }
      // Sweep the complete repository prefix after item-aware cleanup. This
      // catches abandoned upload objects that never gained an item/version row.
      await dependencies.deleteRepositoryStorage(claim.repositoryId);
      if (await dependencies.finalize(claim)) purged += 1;
    } catch (error) {
      try {
        await dependencies.retainDeletingForRetry(claim, now);
      } catch (retainError) {
        failures.push(
          new Error(
            `Failed to retain deleting Nexus repository purge ${claim.repositoryId}`,
            { cause: retainError }
          )
        );
      }
      failures.push(
        new Error(`Failed to purge Nexus repository ${claim.repositoryId}`, {
          cause: error,
        })
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} Nexus repository lifecycle operation(s) failed`
    );
  }
  return { expired, purged };
}
