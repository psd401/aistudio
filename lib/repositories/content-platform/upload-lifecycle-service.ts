import { and, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import { repositoryUploadSessions } from "@/lib/db/schema";
import { deleteRepositoryObjectVersions } from "@/lib/aws/s3-client";
import {
  createRepositoryUploadStorage,
  type RepositoryUploadStorage,
} from "./upload-service";
import { REPOSITORY_UPLOAD_SETTLE_MS } from "./upload-state";

export const UPLOAD_CLEANUP_BATCH_SIZE = 25;
/**
 * Delay the final sweep long enough for a request accepted immediately before
 * signature expiry to finish. The temporary-object S3 tag lifecycle is the
 * durable backstop for a request that outlives even this bounded settle phase.
 */
export const UPLOAD_CLEANUP_LEASE_MS = REPOSITORY_UPLOAD_SETTLE_MS;

export interface RepositoryUploadCleanupClaim {
  sessionId: string;
  objectKey: string;
  uploadMethod: "single" | "multipart";
  multipartUploadId: string | null;
  claimedAt: Date;
  cleanupPhase: "initial" | "final";
}

export interface RepositoryUploadLifecycleResult {
  claimed: number;
  cleaned: number;
}

export interface RepositoryUploadLifecycleOptions {
  now?: Date;
  batchSize?: number;
}

export interface RepositoryUploadLifecycleDependencies {
  claim(input: {
    now: Date;
    staleLeaseBefore: Date;
    batchSize: number;
  }): Promise<RepositoryUploadCleanupClaim[]>;
  abortMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
  }): Promise<void>;
  deleteObjectVersions(objectKey: string): Promise<number>;
  finalize(claim: RepositoryUploadCleanupClaim): Promise<boolean>;
}

let uploadStoragePromise: Promise<RepositoryUploadStorage> | null = null;

function getUploadStorage(): Promise<RepositoryUploadStorage> {
  uploadStoragePromise ??= createRepositoryUploadStorage();
  return uploadStoragePromise;
}

const defaultDependencies: RepositoryUploadLifecycleDependencies = {
  async claim(input) {
    const result = await executeTransaction(
      (tx) =>
        tx.execute(sql`
          WITH selected AS (
            SELECT session.id, session.status AS previous_status
            FROM repository_upload_sessions session
            WHERE (
                session.status IN ('initiated', 'uploading', 'uploaded')
                AND session.expires_at <=
                  ${input.now.toISOString()}::timestamptz
              )
              OR (
                session.status = 'expired'
                AND session.updated_at <=
                  ${input.staleLeaseBefore.toISOString()}::timestamptz
              )
            ORDER BY session.expires_at, session.id
            FOR UPDATE SKIP LOCKED
            LIMIT ${input.batchSize}
          )
          UPDATE repository_upload_sessions session
          SET status = 'expired',
              updated_at = ${input.now.toISOString()}::timestamptz
          FROM selected
          WHERE session.id = selected.id
          RETURNING
            session.id,
            session.object_key,
            session.upload_method,
            session.multipart_upload_id,
            session.updated_at,
            selected.previous_status
        `),
      "contentPlatform.claimExpiredUploadSessions"
    );
    return toPgRows<{
      id: string;
      object_key: string;
      upload_method: "single" | "multipart";
      multipart_upload_id: string | null;
      updated_at: Date | string;
      previous_status: "initiated" | "uploading" | "uploaded" | "expired";
    }>(result).map((row) => ({
      sessionId: row.id,
      objectKey: row.object_key,
      uploadMethod: row.upload_method,
      multipartUploadId: row.multipart_upload_id,
      claimedAt:
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
      cleanupPhase: row.previous_status === "expired" ? "final" : "initial",
    }));
  },

  async abortMultipartUpload(input) {
    const storage = await getUploadStorage();
    await storage.abortMultipartUpload(input);
  },

  deleteObjectVersions: deleteRepositoryObjectVersions,

  async finalize(claim) {
    if (claim.cleanupPhase === "initial") {
      // Keep the leased `expired` row visible for one scheduled final sweep.
      // Merely changing it to `aborted` here would make a single PUT that began
      // just before URL expiry capable of landing permanently after cleanup.
      const result = await executeQuery(
        (db) =>
          db
            .select({ id: repositoryUploadSessions.id })
            .from(repositoryUploadSessions)
            .where(
              and(
                eq(repositoryUploadSessions.id, claim.sessionId),
                eq(repositoryUploadSessions.status, "expired"),
                eq(repositoryUploadSessions.updatedAt, claim.claimedAt)
              )
            )
            .limit(1),
        "contentPlatform.deferExpiredUploadFinalSweep"
      );
      return result.length === 1;
    }
    const result = await executeQuery(
      (db) =>
        db
          .update(repositoryUploadSessions)
          .set({ status: "aborted", updatedAt: new Date() })
          .where(
            and(
              eq(repositoryUploadSessions.id, claim.sessionId),
              eq(repositoryUploadSessions.status, "expired"),
              eq(repositoryUploadSessions.updatedAt, claim.claimedAt)
            )
          )
          .returning({ id: repositoryUploadSessions.id }),
      "contentPlatform.finalizeExpiredUploadSession"
    );
    return result.length === 1;
  },
};

function isMissingMultipartUpload(error: unknown): boolean {
  if (typeof error !== "object" || error == null) return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NoSuchUpload" ||
    candidate.Code === "NoSuchUpload" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function cleanupUploadClaim(
  claim: RepositoryUploadCleanupClaim,
  dependencies: RepositoryUploadLifecycleDependencies
): Promise<boolean> {
  if (claim.uploadMethod === "multipart" && claim.multipartUploadId) {
    try {
      await dependencies.abortMultipartUpload({
        objectKey: claim.objectKey,
        uploadId: claim.multipartUploadId,
      });
    } catch (error) {
      if (!isMissingMultipartUpload(error)) throw error;
    }
  }
  await dependencies.deleteObjectVersions(claim.objectKey);
  return dependencies.finalize(claim);
}

/**
 * Reclaim abandoned direct uploads. Multipart state is aborted first, then all
 * object versions are removed in case S3 completion succeeded but the database
 * completion transaction did not. The row remains `expired` for a delayed
 * second sweep before becoming terminal `aborted`, closing the request-in-flight
 * window at URL expiry. Claims are leased and safely retried.
 */
export async function cleanupExpiredRepositoryUploads(
  options: RepositoryUploadLifecycleOptions = {},
  dependencies: RepositoryUploadLifecycleDependencies = defaultDependencies
): Promise<RepositoryUploadLifecycleResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? UPLOAD_CLEANUP_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("Upload cleanup batch size must be between 1 and 100");
  }

  const claims = await dependencies.claim({
    now,
    staleLeaseBefore: new Date(now.getTime() - UPLOAD_CLEANUP_LEASE_MS),
    batchSize,
  });
  let cleaned = 0;
  const failures: Error[] = [];

  for (const claim of claims) {
    try {
      if (await cleanupUploadClaim(claim, dependencies)) cleaned += 1;
    } catch (error) {
      failures.push(
        new Error(`Failed to clean repository upload ${claim.sessionId}`, {
          cause: error,
        })
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} repository upload cleanup operation(s) failed`
    );
  }
  return { claimed: claims.length, cleaned };
}
