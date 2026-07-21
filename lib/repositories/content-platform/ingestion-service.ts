import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { executeTransaction } from "@/lib/db/drizzle-client";
import {
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  type RepositoryItemVersionRow,
  type RepositoryProcessingJobRow,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";
import { getContentPlatformConfig, isContentDualWriteActive } from "./config";
import {
  buildProcessingIdempotencyKey,
  CONTENT_PROCESSOR_CONTRACT_VERSION,
} from "./job-state";

export interface RegisterCanonicalUploadInput {
  itemId: number;
  userId: number;
  objectKey: string;
  originalFileName: string;
  declaredContentType: string;
  byteSize: number;
  sha256?: string;
  traceId?: string;
}

export interface CanonicalUploadRegistration {
  version: RepositoryItemVersionRow;
  inspectJob: RepositoryProcessingJobRow;
  created: boolean;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function validateInput(input: RegisterCanonicalUploadInput): void {
  if (!Number.isSafeInteger(input.itemId) || input.itemId <= 0) {
    throw new Error("A valid repository item id is required");
  }
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("A valid user id is required");
  }
  if (!input.objectKey.trim()) throw new Error("Object key is required");
  if (!input.originalFileName.trim()) throw new Error("Original file name is required");
  if (!input.declaredContentType.trim()) {
    throw new Error("Declared content type is required");
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    throw new Error("Byte size must be a positive safe integer");
  }
  if (input.sha256 != null && !SHA256_PATTERN.test(input.sha256)) {
    throw new Error("SHA-256 must be 64 lowercase hexadecimal characters");
  }
}

export function sourceRevisionForObjectKey(objectKey: string): string {
  return `s3:${createHash("sha256").update(objectKey).digest("hex")}`;
}

async function ensureInspectJob(
  tx: Parameters<Parameters<typeof executeTransaction>[0]>[0],
  version: RepositoryItemVersionRow,
  traceId?: string
): Promise<RepositoryProcessingJobRow> {
  const idempotencyKey = buildProcessingIdempotencyKey(version.id, "inspect");
  const [existing] = await tx
    .select()
    .from(repositoryProcessingJobs)
    .where(eq(repositoryProcessingJobs.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) return existing;

  const [created] = await tx
    .insert(repositoryProcessingJobs)
    .values({
      itemVersionId: version.id,
      stage: "inspect",
      status: "pending",
      idempotencyKey,
      maxAttempts: 20,
      traceId,
    })
    .returning();
  if (!created) throw new Error("Failed to create canonical inspection job");
  return created;
}

/**
 * Register an already-uploaded S3 object as an immutable, quarantined source
 * version and create its durable inspection job in the same transaction.
 * Repeating the same object key is idempotent.
 */
export async function registerCanonicalUpload(
  input: RegisterCanonicalUploadInput
): Promise<CanonicalUploadRegistration> {
  validateInput(input);
  const sourceRevision = sourceRevisionForObjectKey(input.objectKey);

  return executeTransaction(
    async (tx) => {
      const [item] = await tx
        .select({ id: repositoryItems.id })
        .from(repositoryItems)
        .where(eq(repositoryItems.id, input.itemId))
        .limit(1)
        .for("update");
      if (!item) {
        throw ErrorFactories.dbRecordNotFound("repository_items", input.itemId);
      }

      const [existing] = await tx
        .select()
        .from(repositoryItemVersions)
        .where(
          and(
            eq(repositoryItemVersions.itemId, input.itemId),
            eq(repositoryItemVersions.sourceRevision, sourceRevision)
          )
        )
        .limit(1);

      if (existing) {
        const inspectJob = await ensureInspectJob(tx, existing, input.traceId);
        return { version: existing, inspectJob, created: false };
      }

      const [latest] = await tx
        .select({ versionNumber: repositoryItemVersions.versionNumber })
        .from(repositoryItemVersions)
        .where(eq(repositoryItemVersions.itemId, input.itemId))
        .orderBy(desc(repositoryItemVersions.versionNumber))
        .limit(1);

      const [version] = await tx
        .insert(repositoryItemVersions)
        .values({
          itemId: input.itemId,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          sourceKind: "upload",
          sourceRevision,
          objectKey: input.objectKey,
          declaredContentType: input.declaredContentType,
          byteSize: input.byteSize,
          sha256: input.sha256,
          storageStatus: "quarantined",
          processingStatus: "pending",
          processorVersion: CONTENT_PROCESSOR_CONTRACT_VERSION,
          metadata: { originalFileName: input.originalFileName },
          createdBy: input.userId,
        })
        .returning();
      if (!version) throw new Error("Failed to create canonical item version");

      await tx
        .update(repositoryItems)
        .set({
          currentVersionId: version.id,
          lifecycleStatus: "active",
          updatedAt: new Date(),
        })
        .where(eq(repositoryItems.id, input.itemId));

      const inspectJob = await ensureInspectJob(tx, version, input.traceId);
      return { version, inspectJob, created: true };
    },
    "contentPlatform.registerCanonicalUpload"
  );
}

/** Controlled-rollout wrapper used by legacy upload paths. */
export async function registerCanonicalUploadIfEnabled(
  input: RegisterCanonicalUploadInput
): Promise<CanonicalUploadRegistration | null> {
  const config = await getContentPlatformConfig();
  if (!isContentDualWriteActive(config)) return null;
  return registerCanonicalUpload(input);
}
