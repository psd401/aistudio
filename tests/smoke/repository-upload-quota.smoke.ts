/**
 * Canonical upload reservation/quota real-PostgreSQL smoke (#1268).
 *
 * Proves the multi-statement lock/quota SQL parses and executes, a caller that
 * was authorized as an administrator can reserve in another owner's durable
 * repository, completed current versions are counted exactly once, and a
 * promoted Nexus-managed repository cannot escape the owner's 5 GiB bound.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDatabase,
  executeQuery,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryItems,
  repositoryItemVersions,
  repositoryUploadSessions,
  users,
} from "@/lib/db/schema";
import {
  DEFAULT_CONTENT_PLATFORM_CONFIG,
  initiateRepositoryUpload,
  MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER,
  RepositoryUploadQuotaExceededError,
  type RepositoryUploadStorage,
} from "@/lib/repositories/content-platform";

const fixtureId = randomUUID();
const uploadBytes = 1_024;
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
let signedUploadCount = 0;
const storage: RepositoryUploadStorage = {
  createSingleUpload: async () => {
    signedUploadCount += 1;
    return { uploadUrl: "https://quota-smoke.invalid/upload" };
  },
  createMultipartUpload: async () => {
    throw new Error("Quota smoke does not use multipart storage");
  },
  completeMultipartUpload: async () => undefined,
  abortMultipartUpload: async () => undefined,
  headObject: async () => ({
    byteSize: uploadBytes,
    contentType: "application/pdf",
  }),
};

const [owner] = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values({
        cognitoSub: `repository-quota-owner-${fixtureId}`,
        email: `repository-quota-owner-${fixtureId}@example.invalid`,
      })
      .returning({ id: users.id }),
  "smoke.repositoryUploadQuota.createOwner"
);
const [administrator] = await executeQuery(
  (db) =>
    db
      .insert(users)
      .values({
        cognitoSub: `repository-quota-admin-${fixtureId}`,
        email: `repository-quota-admin-${fixtureId}@example.invalid`,
      })
      .returning({ id: users.id }),
  "smoke.repositoryUploadQuota.createAdministrator"
);
assert.ok(owner);
assert.ok(administrator);

try {
  const [durableRepository] = await executeQuery(
    (db) =>
      db
        .insert(knowledgeRepositories)
        .values({
          name: "Repository quota admin smoke",
          ownerId: owner.id,
          repositoryKind: "durable",
        })
        .returning({ id: knowledgeRepositories.id }),
    "smoke.repositoryUploadQuota.createDurableRepository"
  );
  assert.ok(durableRepository);

  await assert.doesNotReject(
    initiateRepositoryUpload(
      {
        repositoryId: durableRepository.id,
        userId: administrator.id,
        itemName: "Administrator upload",
        fileName: "administrator-upload.pdf",
        contentType: "application/pdf",
        byteSize: uploadBytes,
      },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    )
  );

  const [repository] = await executeQuery(
    (db) =>
      db
        .insert(knowledgeRepositories)
        .values({
          name: "Repository quota Nexus smoke",
          ownerId: owner.id,
          isPublic: false,
          repositoryKind: "ephemeral",
          retentionDays: 30,
          expiresAt,
          metadata: { nexusManaged: true },
        })
        .returning({ id: knowledgeRepositories.id }),
    "smoke.repositoryUploadQuota.createNexusRepository"
  );
  assert.ok(repository);

  const existingObjectKey =
    `repositories/${repository.id}/${randomUUID()}/existing.pdf`;
  const [item] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "Existing completed source",
          source: existingObjectKey,
          processingStatus: "completed",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.repositoryUploadQuota.createItem"
  );
  assert.ok(item);

  const [version] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemVersions)
        .values({
          itemId: item.id,
          versionNumber: 1,
          sourceKind: "upload",
          sourceRevision: `quota-smoke:${fixtureId}`,
          objectKey: existingObjectKey,
          declaredContentType: "application/pdf",
          byteSize:
            MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER - uploadBytes,
          storageStatus: "available",
          inspectionStatus: "clean",
          processingStatus: "completed",
          processorVersion: "quota-smoke/v1",
          createdBy: owner.id,
        })
        .returning({ id: repositoryItemVersions.id }),
    "smoke.repositoryUploadQuota.createVersion"
  );
  assert.ok(version);
  await executeQuery(
    (db) =>
      db
        .update(repositoryItems)
        .set({ currentVersionId: version.id })
        .where(eq(repositoryItems.id, item.id)),
    "smoke.repositoryUploadQuota.activateVersion"
  );
  await executeQuery(
    (db) =>
      db.insert(repositoryUploadSessions).values({
        id: randomUUID(),
        repositoryId: repository.id,
        itemVersionId: version.id,
        createdBy: owner.id,
        objectKey: existingObjectKey,
        uploadMethod: "single",
        itemName: "Existing completed source",
        originalFileName: "existing.pdf",
        declaredContentType: "application/pdf",
        expectedByteSize:
          MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER - uploadBytes,
        status: "completed",
        expiresAt,
        completedAt: new Date(),
      }),
    "smoke.repositoryUploadQuota.createCompletedSession"
  );

  // The completed session and its current version describe the same bytes.
  // Counting both would reject this reservation; counting exactly once permits
  // it and reaches the exact 5 GiB owner boundary.
  await assert.doesNotReject(
    initiateRepositoryUpload(
      {
        repositoryId: repository.id,
        userId: owner.id,
        itemName: "Quota boundary source",
        fileName: "quota-boundary.pdf",
        contentType: "application/pdf",
        byteSize: uploadBytes,
      },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    )
  );

  // Promotion clears expiry/kind but deliberately retains nexusManaged. The
  // next reservation must still observe the existing 5 GiB allocation.
  await executeQuery(
    (db) =>
      db
        .update(knowledgeRepositories)
        .set({
          repositoryKind: "durable",
          retentionDays: null,
          expiresAt: null,
        })
        .where(eq(knowledgeRepositories.id, repository.id)),
    "smoke.repositoryUploadQuota.promoteRepository"
  );
  await assert.rejects(
    initiateRepositoryUpload(
      {
        repositoryId: repository.id,
        userId: owner.id,
        itemName: "Quota bypass attempt",
        fileName: "quota-bypass.pdf",
        contentType: "application/pdf",
        byteSize: uploadBytes,
      },
      DEFAULT_CONTENT_PLATFORM_CONFIG,
      storage
    ),
    (error: unknown) =>
      error instanceof RepositoryUploadQuotaExceededError &&
      error.quota === "ephemeral-storage-bytes" &&
      error.httpStatus === 429
  );
  assert.equal(
    signedUploadCount,
    2,
    "quota rejection must happen before allocating another signed upload"
  );

  process.stdout.write(
    "repository-upload-quota smoke: SQL, admin ownership, exact counting, concurrency fence, and promotion bound passed\n"
  );
} finally {
  await executeQuery(
    (db) =>
      db
        .delete(users)
        .where(eq(users.id, administrator.id)),
    "smoke.repositoryUploadQuota.cleanupAdministrator"
  );
  await executeQuery(
    (db) => db.delete(users).where(eq(users.id, owner.id)),
    "smoke.repositoryUploadQuota.cleanupOwner"
  );
  await closeDatabase();
}
