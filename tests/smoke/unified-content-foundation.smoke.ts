/**
 * Unified repository content real-database smoke (Epic #1261, #1265).
 *
 * Applies to a local database with migration 116 and the standard local seed.
 * Creates an isolated repository/item, registers the same uploaded object twice,
 * and proves immutable-version/job idempotency plus the active-generation guard.
 * All fixtures are deleted in finally.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run test:smoke:unified-content
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql, type SQL } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import {
  closeDatabase,
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryArtifacts,
  repositoryIndexGenerations,
  repositoryItemChunks,
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  repositoryUploadSessions,
  users,
} from "@/lib/db/schema";
import {
  extractPdfText,
  extractOfficeDocument,
  extractCanonicalTextDocument,
  buildImageSearchDocument,
  buildRepositorySourceObjectKey,
  canAcknowledgeCanonicalEmbeddingDlqMessage,
  canAcknowledgeRepositoryProcessingDlqMessage,
  claimLegacyInlineTextRecoveries,
  claimIncompleteEmbeddingGenerations,
  claimRepositoryProcessingJob,
  completeLegacyInlineTextRecovery,
  failLegacyInlineTextRecovery,
  CONTENT_PROCESSING_MAX_ATTEMPTS,
  DEFAULT_CONTENT_PLATFORM_CONFIG,
  completeRepositoryUpload,
  initiateRepositoryUpload,
  PDF_PROCESSOR_VERSION,
  OFFICE_CONTENT_TYPES,
  IMAGE_PROCESSOR_VERSION,
  POST_DEPLOY_ARTIFACT_RECOVERY_MARKER,
  publishDocumentVersion,
  publishPdfVersion,
  POST_DEPLOY_RECOVERY_MARKER,
  recordRepositoryProcessingFailure,
  recordRepositorySecurityBlock,
  reconcileRepositoryProcessingDlqMessage,
  releaseIncompleteEmbeddingGenerationClaim,
  releasePostDeployRecoveryJobs,
  getCanonicalRepositoryItemStatuses,
  registerCanonicalUpload,
  retryCanonicalRepositoryItem,
  segmentPdfPages,
  sourceRevisionForObjectKey,
  type RepositoryUploadStorage,
} from "@/lib/repositories/content-platform";
import { keywordSearch } from "@/lib/repositories/search-service";
import { retrieveRepositoryContent } from "@/lib/repositories/retrieval-v2/service";
import {
  activateCompletedGeneration,
  type GenerationActivationExecutor,
  type GenerationActivationResult,
} from "../../infra/lambdas/embedding-generator/generation-activation";
import { failBuildingGeneration } from "../../infra/lambdas/embedding-generator/generation-lifecycle";

const pdf = await PDFDocument.create();
const postDeployHandoffSql = readFileSync(
  resolve(
    process.cwd(),
    "infra/database/schema/123-unified-content-postdeploy-handoff.sql"
  ),
  "utf8"
);
const postDeployHandoffStatements = postDeployHandoffSql
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);
const artifactStateRecoverySql = readFileSync(
  resolve(
    process.cwd(),
    "infra/database/schema/124-unified-content-artifact-state-recovery.sql"
  ),
  "utf8"
);
const artifactStateRecoveryStatements = artifactStateRecoverySql
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

async function applyPostDeployHandoff(context: string): Promise<void> {
  for (const [index, statement] of postDeployHandoffStatements.entries()) {
    await executeQuery(
      (db) => db.execute(sql.raw(statement)),
      `${context}.${index + 1}`
    );
  }
}

async function applyArtifactStateRecovery(context: string): Promise<void> {
  for (const [index, statement] of artifactStateRecoveryStatements.entries()) {
    await executeQuery(
      (db) => db.execute(sql.raw(statement)),
      `${context}.${index + 1}`
    );
  }
}

// The deployment always migrates the database before the application or worker
// loads the expanded Drizzle schema. Reproduce that order in the standalone
// smoke, whose local database may predate this branch.
await applyPostDeployHandoff("smoke.unifiedContent.ensurePostDeploySchema");
await applyArtifactStateRecovery(
  "smoke.unifiedContent.ensureArtifactRecoverySchema"
);
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const text of [
  "Page one contains the district emergency procedure and contact instructions.",
  "Page two contains the citation details and implementation timeline.",
]) {
  const page = pdf.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 740, size: 12, font });
}
const extractedPdf = await extractPdfText(await pdf.save());
const pdfSegments = segmentPdfPages(extractedPdf.pages);
assert.equal(extractedPdf.pageCount, 2);
assert.equal(extractedPdf.needsOcrPages.length, 0);
assert.deepEqual(
  pdfSegments.map((segment) => segment.sourceLocator.page),
  [1, 2]
);

const [owner] = await executeQuery(
  (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.cognitoSub, "e2e-test-user"))
      .limit(1),
  "smoke.unifiedContent.owner"
);
assert.ok(owner, "standard local seed is missing e2e-test-user");

const [repository] = await executeQuery(
  (db) =>
    db
      .insert(knowledgeRepositories)
      .values({
        name: `Unified content smoke ${Date.now()}`,
        ownerId: owner.id,
        repositoryKind: "durable",
      })
      .returning({ id: knowledgeRepositories.id }),
  "smoke.unifiedContent.createRepository"
);
assert.ok(repository);

try {
  const uploadStorage: RepositoryUploadStorage = {
    createSingleUpload: async () => ({ uploadUrl: "https://smoke.invalid/upload" }),
    createMultipartUpload: async () => {
      throw new Error("Multipart storage should not run in this smoke");
    },
    completeMultipartUpload: async () => undefined,
    abortMultipartUpload: async () => undefined,
    headObject: async () => ({
      byteSize: 4096,
      contentType: "application/pdf",
    }),
  };
  const initiatedUpload = await initiateRepositoryUpload(
    {
      repositoryId: repository.id,
      userId: owner.id,
      itemName: "Secure upload smoke",
      fileName: "secure-upload.pdf",
      contentType: "application/pdf",
      byteSize: 4096,
    },
    DEFAULT_CONTENT_PLATFORM_CONFIG,
    uploadStorage
  );
  const completedUpload = await completeRepositoryUpload(
    {
      repositoryId: repository.id,
      userId: owner.id,
      sessionId: initiatedUpload.sessionId,
    },
    uploadStorage
  );
  const replayedUpload = await completeRepositoryUpload(
    {
      repositoryId: repository.id,
      userId: owner.id,
      sessionId: initiatedUpload.sessionId,
    },
    uploadStorage
  );
  assert.equal(completedUpload.replayed, false);
  assert.equal(replayedUpload.replayed, true);
  assert.equal(replayedUpload.itemVersionId, completedUpload.itemVersionId);
  const [completedSession] = await executeQuery(
    (db) =>
      db
        .select({ status: repositoryUploadSessions.status })
        .from(repositoryUploadSessions)
        .where(eq(repositoryUploadSessions.id, initiatedUpload.sessionId))
        .limit(1),
    "smoke.unifiedContent.completedUploadSession"
  );
  assert.equal(completedSession?.status, "completed");

  const [item] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "reference.pdf",
          source: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/reference.pdf`,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createItem"
  );
  assert.ok(item);

  const input = {
    itemId: item.id,
    userId: owner.id,
    objectKey: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/reference.pdf`,
    originalFileName: "reference.pdf",
    declaredContentType: "application/pdf",
    byteSize: 4096,
    traceId: "unified-content-smoke",
  } as const;

  const first = await registerCanonicalUpload(input);
  const replay = await registerCanonicalUpload(input);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.version.id, first.version.id);
  assert.equal(replay.inspectJob.id, first.inspectJob.id);
  assert.equal(
    await canAcknowledgeRepositoryProcessingDlqMessage({
      jobId: first.inspectJob.id,
      itemVersionId: first.version.id,
    }),
    true
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({ status: "queued" })
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id)),
    "smoke.unifiedContent.simulateQueuedProcessingDlq"
  );
  assert.equal(
    await canAcknowledgeRepositoryProcessingDlqMessage({
      jobId: first.inspectJob.id,
      itemVersionId: first.version.id,
    }),
    false
  );
  const processingDlqRecoveredAt = new Date();
  assert.deepEqual(
    await reconcileRepositoryProcessingDlqMessage(
      { jobId: first.inspectJob.id, itemVersionId: first.version.id },
      processingDlqRecoveredAt
    ),
    { acknowledge: true, recovered: true }
  );
  const [processingDlqRecoveredJob] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryProcessingJobs.status,
          availableAt: repositoryProcessingJobs.availableAt,
          lastErrorCode: repositoryProcessingJobs.lastErrorCode,
        })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readRecoveredProcessingDlqJob"
  );
  assert.equal(processingDlqRecoveredJob?.status, "pending");
  assert.equal(
    processingDlqRecoveredJob?.availableAt.getTime(),
    processingDlqRecoveredAt.getTime()
  );
  assert.equal(
    processingDlqRecoveredJob?.lastErrorCode,
    "PROCESSING_DLQ_RECOVERED"
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          status: "failed",
          attempt: CONTENT_PROCESSING_MAX_ATTEMPTS,
        })
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id)),
    "smoke.unifiedContent.simulateTerminalProcessingDlq"
  );
  assert.deepEqual(
    await reconcileRepositoryProcessingDlqMessage({
      jobId: first.inspectJob.id,
      itemVersionId: first.version.id,
    }),
    { acknowledge: false, recovered: false }
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          status: "pending",
          attempt: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
        })
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id)),
    "smoke.unifiedContent.restoreProcessingJobAfterDlqContract"
  );
  assert.equal(
    await canAcknowledgeRepositoryProcessingDlqMessage({
      jobId: first.inspectJob.id,
      itemVersionId: "11111111-2222-4333-8444-555555555555",
    }),
    false
  );
  assert.equal(
    await canAcknowledgeRepositoryProcessingDlqMessage({
      jobId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      itemVersionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    }),
    true
  );

  const versions = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryItemVersions)
        .where(eq(repositoryItemVersions.itemId, item.id)),
    "smoke.unifiedContent.versions"
  );
  const jobs = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.itemVersionId, first.version.id)),
    "smoke.unifiedContent.jobs"
  );
  const [updatedItem] = await executeQuery(
    (db) =>
      db
        .select({ currentVersionId: repositoryItems.currentVersionId })
        .from(repositoryItems)
        .where(eq(repositoryItems.id, item.id))
        .limit(1),
    "smoke.unifiedContent.currentVersion"
  );

  assert.equal(versions.length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(first.version.storageStatus, "quarantined");
  assert.equal(first.inspectJob.status, "pending");
  assert.equal(first.inspectJob.maxAttempts, CONTENT_PROCESSING_MAX_ATTEMPTS);
  assert.equal(updatedItem?.currentVersionId, first.version.id);

  const [legacyTextItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "text",
          name: "Legacy inline policy",
          source: "Legacy inline source recovery keeps this content.",
          processingStatus: "failed",
          processingError: "Processing job exhausted its retry budget",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createLegacyInlineItem"
  );
  assert.ok(legacyTextItem);
  const [legacyTextVersion] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemVersions)
        .values({
          itemId: legacyTextItem.id,
          versionNumber: 1,
          sourceKind: "upload",
          sourceRevision: "s3:legacy-inline-smoke",
          objectKey: `repositories/${repository.id}/legacy/inline.txt`,
          declaredContentType: "text/plain",
          byteSize: 48,
          storageStatus: "quarantined",
          inspectionStatus: "error",
          processingStatus: "failed",
          processorVersion: "unified-content-v1",
          createdBy: owner.id,
        })
        .returning({ id: repositoryItemVersions.id }),
    "smoke.unifiedContent.createLegacyInlineVersion"
  );
  assert.ok(legacyTextVersion);
  await executeQuery(
    (db) =>
      db
        .update(repositoryItems)
        .set({ currentVersionId: legacyTextVersion.id })
        .where(eq(repositoryItems.id, legacyTextItem.id)),
    "smoke.unifiedContent.attachLegacyInlineVersion"
  );
  const [legacyTextJob] = await executeQuery(
    (db) =>
      db
        .insert(repositoryProcessingJobs)
        .values({
          itemVersionId: legacyTextVersion.id,
          stage: "inspect",
          status: "failed",
          idempotencyKey: `${legacyTextVersion.id}:inspect:unified-content-v1`,
          attempt: CONTENT_PROCESSING_MAX_ATTEMPTS,
          maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
          lastErrorCode: "RETRY_BUDGET_EXHAUSTED",
          lastErrorMessage: "Processing job exhausted its retry budget",
        })
        .returning({ id: repositoryProcessingJobs.id }),
    "smoke.unifiedContent.createLegacyInlineJob"
  );
  assert.ok(legacyTextJob);
  const legacyRecoveryNow = new Date();
  const legacyClaims = await claimLegacyInlineTextRecoveries({
    leaseOwner: "legacy-inline-smoke:first",
    repositoryId: repository.id,
    now: legacyRecoveryNow,
  });
  const firstLegacyClaim = legacyClaims.find(
    (claim) => claim.jobId === legacyTextJob.id
  );
  assert.ok(firstLegacyClaim);
  await failLegacyInlineTextRecovery(
    firstLegacyClaim,
    "simulated S3 recovery outage",
    legacyRecoveryNow
  );
  assert.equal(
    (
      await claimLegacyInlineTextRecoveries({
        leaseOwner: "legacy-inline-smoke:too-early",
        repositoryId: repository.id,
        now: new Date(legacyRecoveryNow.getTime() + 30_000),
      })
    ).some((claim) => claim.jobId === legacyTextJob.id),
    false
  );
  const retriedLegacyClaims = await claimLegacyInlineTextRecoveries({
    leaseOwner: "legacy-inline-smoke:retry",
    repositoryId: repository.id,
    now: new Date(legacyRecoveryNow.getTime() + 61_000),
  });
  const legacyClaim = retriedLegacyClaims.find(
    (claim) => claim.jobId === legacyTextJob.id
  );
  assert.ok(legacyClaim);
  assert.equal(
    await completeLegacyInlineTextRecovery({
      claim: firstLegacyClaim,
      objectKey: buildRepositorySourceObjectKey(
        repository.id,
        `stale-inline-${legacyTextItem.id}.txt`,
        legacyTextVersion.id
      ),
      byteSize: Buffer.byteLength(firstLegacyClaim.content, "utf8"),
      sha256: "e".repeat(64),
      now: new Date(legacyRecoveryNow.getTime() + 61_500),
    }),
    false,
    "a stale recovery owner must not complete after a new invocation claims the job"
  );
  const recoveredInlineKey = buildRepositorySourceObjectKey(
    repository.id,
    `inline-${legacyTextItem.id}.txt`,
    legacyTextVersion.id
  );
  assert.equal(
    await completeLegacyInlineTextRecovery({
      claim: legacyClaim,
      objectKey: recoveredInlineKey,
      byteSize: Buffer.byteLength(legacyClaim.content, "utf8"),
      sha256: "d".repeat(64),
      now: new Date(legacyRecoveryNow.getTime() + 62_000),
    }),
    true
  );
  const [recoveredInlineState] = await executeQuery(
    (db) =>
      db
        .select({
          sourceKind: repositoryItemVersions.sourceKind,
          sourceRevision: repositoryItemVersions.sourceRevision,
          objectKey: repositoryItemVersions.objectKey,
          versionStatus: repositoryItemVersions.processingStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          jobStatus: repositoryProcessingJobs.status,
          jobAttempt: repositoryProcessingJobs.attempt,
          itemSource: repositoryItems.source,
          itemStatus: repositoryItems.processingStatus,
          itemError: repositoryItems.processingError,
        })
        .from(repositoryItemVersions)
        .innerJoin(
          repositoryProcessingJobs,
          eq(repositoryProcessingJobs.itemVersionId, repositoryItemVersions.id)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryItemVersions.id, legacyTextVersion.id))
        .limit(1),
    "smoke.unifiedContent.readRecoveredLegacyInlineState"
  );
  assert.deepEqual(recoveredInlineState, {
    sourceKind: "text",
    sourceRevision: sourceRevisionForObjectKey(recoveredInlineKey),
    objectKey: recoveredInlineKey,
    versionStatus: "pending",
    inspectionStatus: "pending",
    jobStatus: "pending",
    jobAttempt: 0,
    itemSource: recoveredInlineKey,
    itemStatus: "pending",
    itemError: null,
  });

  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          metrics: {
            waitReason: "AWAITING_SECURITY_SCAN",
            waitStartedAt: "2026-07-22T12:00:00.000Z",
          },
        })
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id)),
    "smoke.unifiedContent.persistWaitDeadline"
  );
  const [waitingJob] = await executeQuery(
    (db) =>
      db
        .select({ metrics: repositoryProcessingJobs.metrics })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readWaitDeadline"
  );
  assert.deepEqual(waitingJob?.metrics, {
    waitReason: "AWAITING_SECURITY_SCAN",
    waitStartedAt: "2026-07-22T12:00:00.000Z",
  });

  const retryObjectKey =
    `repositories/${repository.id}/22222222-3333-4444-8555-666666666666/retry-reference.pdf`;
  const [retryItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "retry-reference.pdf",
          source: retryObjectKey,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createRetryItem"
  );
  assert.ok(retryItem);
  const retryRegistration = await registerCanonicalUpload({
    itemId: retryItem.id,
    userId: owner.id,
    objectKey: retryObjectKey,
    originalFileName: "retry-reference.pdf",
    declaredContentType: "application/pdf",
    byteSize: 4096,
    traceId: "unified-content-smoke-retry",
  });
  await executeQuery(
    (db) =>
      db.execute(sql`
        WITH failed_job AS (
          UPDATE repository_processing_jobs
          SET status = 'failed',
              attempt = 1,
              max_attempts = 20,
              last_error_code = 'PROCESSING_ERROR',
              last_error_message = 'simulated terminal processing failure',
              metrics = '{"textractJobId":"stale-provider-job","waitReason":"AWAITING_OCR"}'::jsonb,
              started_at = now(),
              finished_at = now()
          WHERE id = ${retryRegistration.inspectJob.id}::uuid
          RETURNING item_version_id
        ), failed_version AS (
          UPDATE repository_item_versions
          SET inspection_status = 'error', processing_status = 'failed'
          WHERE id IN (SELECT item_version_id FROM failed_job)
          RETURNING item_id
        )
        UPDATE repository_items
        SET processing_status = 'failed',
            processing_error = 'simulated terminal processing failure'
        WHERE id IN (SELECT item_id FROM failed_version)
      `),
    "smoke.unifiedContent.createTerminalRetryState"
  );
  const failedStatuses = await getCanonicalRepositoryItemStatuses(repository.id);
  assert.deepEqual(failedStatuses.get(retryItem.id), {
    itemId: retryItem.id,
    processingStatus: "failed",
    processingError: "simulated terminal processing failure",
    canRetry: true,
  });

  // Migration 123 must not replay an unrelated terminal user failure merely
  // because it is a current canonical inspect job.
  await applyPostDeployHandoff(
    "smoke.unifiedContent.applyPostDeployHandoff"
  );
  const [untouchedFailure] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          attempt: repositoryProcessingJobs.attempt,
          maxAttempts: repositoryProcessingJobs.maxAttempts,
          errorCode: repositoryProcessingJobs.lastErrorCode,
          postDeployRecovery: repositoryProcessingJobs.postDeployRecovery,
          metrics: repositoryProcessingJobs.metrics,
          versionStatus: repositoryItemVersions.processingStatus,
          itemStatus: repositoryItems.processingStatus,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readUnrelatedTerminalFailure"
  );
  assert.deepEqual(untouchedFailure, {
    jobStatus: "failed",
    attempt: 1,
    maxAttempts: 20,
    errorCode: "PROCESSING_ERROR",
    postDeployRecovery: null,
    metrics: {
      textractJobId: "stale-provider-job",
      waitReason: "AWAITING_OCR",
    },
    versionStatus: "failed",
    itemStatus: "failed",
  });

  // Reproduce the exact live post-migration state that requires the handoff:
  // the old runtime cancelled a migration-122 replay while content processing
  // was unavailable during deployment.
  await executeQuery(
    (db) =>
      db.execute(sql`
        WITH cancelled_job AS (
          UPDATE repository_processing_jobs
          SET status = 'cancelled',
              attempt = 2,
              max_attempts = 20,
              last_error_code = 'CONTENT_PLATFORM_DISABLED',
              last_error_message = 'old runtime could not read the canonical source',
              metrics = '{}'::jsonb,
              started_at = now(),
              finished_at = now(),
              updated_at = now()
          WHERE id = ${retryRegistration.inspectJob.id}::uuid
          RETURNING item_version_id
        ), pending_version AS (
          UPDATE repository_item_versions
          SET storage_status = 'quarantined',
              inspection_status = 'pending',
              processing_status = 'pending'
          WHERE id IN (SELECT item_version_id FROM cancelled_job)
          RETURNING item_id
        )
        UPDATE repository_items
        SET processing_status = 'pending',
            processing_error = NULL
        WHERE id IN (SELECT item_id FROM pending_version)
      `),
    "smoke.unifiedContent.createKnownPostDeployFailure"
  );
  await applyPostDeployHandoff(
    "smoke.unifiedContent.reapplyPostDeployHandoff"
  );
  const [quarantinedState] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          attempt: repositoryProcessingJobs.attempt,
          maxAttempts: repositoryProcessingJobs.maxAttempts,
          postDeployRecovery: repositoryProcessingJobs.postDeployRecovery,
          metrics: repositoryProcessingJobs.metrics,
          availableAt: sql<string>`${repositoryProcessingJobs.availableAt}::text`,
          versionStatus: repositoryItemVersions.processingStatus,
          itemStatus: repositoryItems.processingStatus,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readQuarantinedHandoff"
  );
  assert.equal(quarantinedState?.jobStatus, "cancelled");
  assert.equal(quarantinedState?.attempt, 0);
  assert.equal(
    quarantinedState?.maxAttempts,
    CONTENT_PROCESSING_MAX_ATTEMPTS
  );
  assert.deepEqual(quarantinedState?.metrics, {
    postDeployRecovery: POST_DEPLOY_RECOVERY_MARKER,
  });
  assert.equal(
    quarantinedState?.postDeployRecovery,
    POST_DEPLOY_RECOVERY_MARKER
  );
  assert.equal(quarantinedState?.availableAt, "infinity");
  assert.equal(quarantinedState?.versionStatus, "pending");
  assert.equal(quarantinedState?.itemStatus, "pending");

  const quarantinedStatuses = await getCanonicalRepositoryItemStatuses(
    repository.id
  );
  assert.deepEqual(quarantinedStatuses.get(retryItem.id), {
    itemId: retryItem.id,
    processingStatus: "retrying",
    processingError: null,
    canRetry: false,
  });
  await assert.rejects(
    retryCanonicalRepositoryItem(
      retryItem.id,
      "unified-content-smoke-quarantined-retry"
    ),
    /awaiting automatic post-deployment recovery/
  );
  const [blockedRetryState] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryProcessingJobs.status,
          attempt: repositoryProcessingJobs.attempt,
          postDeployRecovery: repositoryProcessingJobs.postDeployRecovery,
          availableAt: sql<string>`${repositoryProcessingJobs.availableAt}::text`,
        })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readBlockedQuarantineRetry"
  );
  assert.deepEqual(blockedRetryState, {
    status: "cancelled",
    attempt: 0,
    postDeployRecovery: POST_DEPLOY_RECOVERY_MARKER,
    availableAt: "infinity",
  });

  const [oldWorkerSweep] = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(repositoryProcessingJobs)
        .where(
          sql`${repositoryProcessingJobs.id} = ${retryRegistration.inspectJob.id}::uuid
            AND ${repositoryProcessingJobs.status} = 'pending'
            AND ${repositoryProcessingJobs.availableAt} <= now()`
        ),
    "smoke.unifiedContent.oldWorkerSweep"
  );
  assert.equal(oldWorkerSweep?.count, 0);

  // A worker invocation that claimed the job before the migration may replace
  // the complete metrics object after the migration commits. The durable column
  // survives because old code does not know about it.
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          metrics: { waitReason: "CONTENT_PLATFORM_DISABLED" },
          updatedAt: new Date(),
        })
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id)),
    "smoke.unifiedContent.simulateStaleWorkerMetricsOverwrite"
  );

  // Every actual stale completion/defer path also tries to move the status. The
  // database invariant rejects that entire write, so old code cannot make the
  // quarantined row claimable again before the replacement runtime releases it.
  await assert.rejects(
    executeQuery(
      (db) =>
        db
          .update(repositoryProcessingJobs)
          .set({
            status: "queued",
            lastErrorCode: "CONTENT_PLATFORM_DISABLED",
            lastErrorMessage: "stale worker deferred after the migration",
            metrics: { waitReason: "CONTENT_PLATFORM_DISABLED" },
            updatedAt: new Date(),
          })
          .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id)),
      "smoke.unifiedContent.rejectStaleWorkerStatusOverwrite"
    )
  );
  const [staleWriteState] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryProcessingJobs.status,
          postDeployRecovery: repositoryProcessingJobs.postDeployRecovery,
          metrics: repositoryProcessingJobs.metrics,
        })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readStaleWorkerOverwrite"
  );
  assert.deepEqual(staleWriteState, {
    status: "cancelled",
    postDeployRecovery: POST_DEPLOY_RECOVERY_MARKER,
    metrics: { waitReason: "CONTENT_PLATFORM_DISABLED" },
  });

  // The replacement runtime must wait longer than the old Lambda's maximum
  // execution time before releasing a marked row.
  assert.deepEqual(await releasePostDeployRecoveryJobs(), []);
  const released = await releasePostDeployRecoveryJobs({
    graceMinutes: 0,
    now: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(released, [
    {
      id: retryRegistration.inspectJob.id,
      itemVersionId: retryRegistration.version.id,
    },
  ]);
  const [releasedState] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          attempt: repositoryProcessingJobs.attempt,
          maxAttempts: repositoryProcessingJobs.maxAttempts,
          postDeployRecovery: repositoryProcessingJobs.postDeployRecovery,
          metrics: repositoryProcessingJobs.metrics,
          versionStatus: repositoryItemVersions.processingStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          itemStatus: repositoryItems.processingStatus,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readReleasedHandoff"
  );
  assert.deepEqual(releasedState, {
    jobStatus: "pending",
    attempt: 0,
    maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
    postDeployRecovery: null,
    metrics: {},
    versionStatus: "pending",
    inspectionStatus: "pending",
    itemStatus: "pending",
  });

  // Even a correctly marked row cannot bypass the canonical source namespace.
  await executeTransaction(
    async (tx) => {
      await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "cancelled",
          availableAt: sql`'infinity'::timestamptz`,
          postDeployRecovery: POST_DEPLOY_RECOVERY_MARKER,
          metrics: { postDeployRecovery: POST_DEPLOY_RECOVERY_MARKER },
        })
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id));
      await tx
        .update(repositoryItemVersions)
        .set({
          objectKey: `repositories/${repository.id}/legacy/retry-reference.pdf`,
        })
        .where(eq(repositoryItemVersions.id, retryRegistration.version.id));
    },
    "smoke.unifiedContent.createNoncanonicalMarkedHandoff"
  );
  assert.deepEqual(
    await releasePostDeployRecoveryJobs({
      graceMinutes: 0,
      now: new Date(Date.now() + 60_000),
    }),
    []
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryItemVersions)
        .set({ objectKey: retryObjectKey })
        .where(eq(repositoryItemVersions.id, retryRegistration.version.id)),
    "smoke.unifiedContent.restoreCanonicalRetrySource"
  );
  assert.deepEqual(
    await releasePostDeployRecoveryJobs({
      graceMinutes: 0,
      now: new Date(Date.now() + 60_000),
    }),
    [
      {
        id: retryRegistration.inspectJob.id,
        itemVersionId: retryRegistration.version.id,
      },
    ]
  );

  // A user retry gets another clean bounded budget even when the terminal row
  // was cancelled and still carried provider state from an earlier runtime.
  await executeQuery(
    (db) =>
      db.execute(sql`
        WITH cancelled_job AS (
          UPDATE repository_processing_jobs
          SET status = 'cancelled',
              attempt = 4,
              max_attempts = 20,
              metrics = '{"textractJobId":"stale-cancelled-job"}'::jsonb,
              started_at = now(),
              finished_at = now()
          WHERE id = ${retryRegistration.inspectJob.id}::uuid
          RETURNING item_version_id
        ), cancelled_version AS (
          UPDATE repository_item_versions
          SET inspection_status = 'error', processing_status = 'cancelled'
          WHERE id IN (SELECT item_version_id FROM cancelled_job)
          RETURNING item_id
        )
        UPDATE repository_items
        SET processing_status = 'failed',
            processing_error = 'simulated cancelled deployment job'
        WHERE id IN (SELECT item_id FROM cancelled_version)
      `),
    "smoke.unifiedContent.createCancelledRetryState"
  );
  const [newerDownstreamJob] = await executeQuery(
    (db) =>
      db
        .insert(repositoryProcessingJobs)
        .values({
          itemVersionId: retryRegistration.version.id,
          stage: "normalize",
          status: "succeeded",
          idempotencyKey: `${retryRegistration.version.id}:normalize:smoke`,
          finishedAt: new Date(),
        })
        .returning({ id: repositoryProcessingJobs.id }),
    "smoke.unifiedContent.createNewerDownstreamJob"
  );
  assert.ok(newerDownstreamJob);
  const restarted = await retryCanonicalRepositoryItem(
    retryItem.id,
    "unified-content-smoke-manual-retry"
  );
  assert.equal(restarted.itemVersionId, retryRegistration.version.id);
  assert.equal(restarted.processingJobId, retryRegistration.inspectJob.id);
  const [restartedState] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          attempt: repositoryProcessingJobs.attempt,
          maxAttempts: repositoryProcessingJobs.maxAttempts,
          postDeployRecovery: repositoryProcessingJobs.postDeployRecovery,
          metrics: repositoryProcessingJobs.metrics,
          startedAt: repositoryProcessingJobs.startedAt,
          versionStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          itemStatus: repositoryItems.processingStatus,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.id, repositoryItemVersions.itemId)
        )
        .where(eq(repositoryProcessingJobs.id, retryRegistration.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readRestartedState"
  );
  assert.equal(restartedState?.jobStatus, "pending");
  assert.equal(restartedState?.attempt, 0);
  assert.equal(restartedState?.maxAttempts, CONTENT_PROCESSING_MAX_ATTEMPTS);
  assert.equal(restartedState?.postDeployRecovery, null);
  assert.deepEqual(restartedState?.metrics, {});
  assert.equal(restartedState?.startedAt, null);
  assert.equal(restartedState?.versionStatus, "pending");
  assert.equal(restartedState?.storageStatus, "quarantined");
  assert.equal(restartedState?.itemStatus, "pending");
  const [downstreamState] = await executeQuery(
    (db) =>
      db
        .select({ status: repositoryProcessingJobs.status })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, newerDownstreamJob.id))
        .limit(1),
    "smoke.unifiedContent.readUnchangedDownstreamJob"
  );
  assert.equal(downstreamState?.status, "succeeded");

  const publication = await publishPdfVersion({
    itemVersionId: first.version.id,
    processorVersion: PDF_PROCESSOR_VERSION,
    inspectionStatus: "clean",
    inspectionDetails: { provider: "smoke", result: "NO_THREATS_FOUND" },
    malwareScanRequired: true,
    canonicalText: extractedPdf.canonicalText,
    segments: pdfSegments,
  });
  const publicationReplay = await publishPdfVersion({
    itemVersionId: first.version.id,
    processorVersion: PDF_PROCESSOR_VERSION,
    inspectionStatus: "clean",
    malwareScanRequired: true,
    canonicalText: extractedPdf.canonicalText,
    segments: pdfSegments,
  });
  assert.equal(publication.replayed, false);
  assert.equal(publicationReplay.replayed, true);
  assert.equal(publicationReplay.generationId, publication.generationId);

  const publishedChunks = await executeQuery(
    (db) =>
      db
        .select({
          id: repositoryItemChunks.id,
          page: repositoryItemChunks.sourceLocator,
          generationId: repositoryItemChunks.indexGenerationId,
        })
        .from(repositoryItemChunks)
        .where(eq(repositoryItemChunks.itemVersionId, first.version.id)),
    "smoke.unifiedContent.publishedChunks"
  );
  assert.deepEqual(
    publishedChunks.map((chunk) => chunk.page.page),
    [1, 2]
  );
  assert.ok(
    publishedChunks.every(
      (chunk) => chunk.generationId === publication.generationId
    )
  );

  // Reproduce the deployed image failure shape: a searchable current version
  // has an intentional v1 -> v2 background rebuild carrying a v1 Textract
  // artifact key. Active chunks keep the old generation serving, but must not
  // make the durable upgrade job look complete.
  await executeQuery(
    (db) =>
      db.execute(sql`
        WITH stale_job AS (
          UPDATE repository_processing_jobs
          SET status = 'queued',
              attempt = 16,
              max_attempts = 20,
              last_error_code = 'TRANSIENT_PROCESSING_ERROR',
              last_error_message = 'Textract job does not match the normalized image artifact',
              metrics = '{"textractJobId":"v1-job","textractObjectKey":"repositories/7/artifacts/version/image-normalize-v1/ocr-source.jpg","waitReason":"AWAITING_OCR"}'::jsonb,
              finished_at = NULL,
              updated_at = now()
          WHERE id = ${first.inspectJob.id}::uuid
          RETURNING item_version_id
        ), stale_version AS (
          UPDATE repository_item_versions
          SET storage_status = 'quarantined',
              inspection_status = 'pending',
              processing_status = 'processing'
          WHERE id IN (SELECT item_version_id FROM stale_job)
          RETURNING item_id
        )
        UPDATE repository_items
        SET processing_status = 'processing',
            processing_error = 'stale worker state'
        WHERE id IN (SELECT item_id FROM stale_version)
      `),
    "smoke.unifiedContent.createActiveStaleWorkerState"
  );
  const activeUpgradeClaim = await claimRepositoryProcessingJob(
    {
      jobId: first.inspectJob.id,
      itemVersionId: first.version.id,
    },
    "unified-content-smoke-worker",
    { now: new Date("2026-07-22T21:00:00.000Z") }
  );
  assert.equal(activeUpgradeClaim?.status, "running");
  assert.equal(activeUpgradeClaim?.attempt, 17);
  const [workerClaimed] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          jobError: repositoryProcessingJobs.lastErrorMessage,
          versionStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          itemStatus: repositoryItems.processingStatus,
          itemError: repositoryItems.processingError,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readWorkerClaimedActiveUpgrade"
  );
  assert.deepEqual(workerClaimed, {
    jobStatus: "running",
    jobError: "Textract job does not match the normalized image artifact",
    versionStatus: "processing",
    storageStatus: "quarantined",
    inspectionStatus: "pending",
    itemStatus: "processing",
    itemError: "stale worker state",
  });
  assert.equal(
    (await getCanonicalRepositoryItemStatuses(repository.id)).get(first.version.itemId)
      ?.processingStatus,
    "embedded"
  );

  // Execute migration 124 against the in-flight active upgrade. This covers the
  // database-first deployment window: the known-bad artifact runtime is fenced
  // until old invocations drain, while the old generation remains searchable.
  await executeQuery(
    (db) =>
      db.execute(sql`
        WITH stale_job AS (
          UPDATE repository_processing_jobs
          SET status = 'queued',
              attempt = 16,
              max_attempts = 20,
              last_error_code = 'TRANSIENT_PROCESSING_ERROR',
              last_error_message = 'Textract job does not match the normalized image artifact',
              metrics = '{"textractJobId":"v1-job","textractObjectKey":"repositories/7/artifacts/version/image-normalize-v1/ocr-source.jpg"}'::jsonb,
              finished_at = NULL,
              updated_at = now()
          WHERE id = ${first.inspectJob.id}::uuid
          RETURNING item_version_id
        ), stale_version AS (
          UPDATE repository_item_versions
          SET storage_status = 'quarantined',
              inspection_status = 'pending',
              processing_status = 'processing'
          WHERE id IN (SELECT item_version_id FROM stale_job)
          RETURNING item_id
        )
        UPDATE repository_items
        SET processing_status = 'processing',
            processing_error = 'stale migration state'
        WHERE id IN (SELECT item_id FROM stale_version)
      `),
    "smoke.unifiedContent.recreateActiveStaleMigrationState"
  );
  await applyArtifactStateRecovery(
    "smoke.unifiedContent.applyActiveArtifactRecovery"
  );
  const [migrationQuarantined] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          versionStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          itemStatus: repositoryItems.processingStatus,
          itemError: repositoryItems.processingError,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readMigrationQuarantinedActiveUpgrade"
  );
  assert.deepEqual(migrationQuarantined, {
    jobStatus: "cancelled",
    versionStatus: "completed",
    storageStatus: "available",
    inspectionStatus: "clean",
    itemStatus: "embedded",
    itemError: null,
  });
  assert.equal(
    (await getCanonicalRepositoryItemStatuses(repository.id)).get(first.version.itemId)
      ?.processingStatus,
    "embedded"
  );
  const releasedActiveUpgrade = await releasePostDeployRecoveryJobs({
    graceMinutes: 0,
    now: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(releasedActiveUpgrade, [
    { id: first.inspectJob.id, itemVersionId: first.version.id },
  ]);
  const reclaimedActiveUpgrade = await claimRepositoryProcessingJob(
    {
      jobId: first.inspectJob.id,
      itemVersionId: first.version.id,
    },
    "unified-content-smoke-replacement-worker",
    { now: new Date(Date.now() + 120_000) }
  );
  assert.equal(reclaimedActiveUpgrade?.status, "running");
  assert.equal(reclaimedActiveUpgrade?.attempt, 1);
  assert.deepEqual(reclaimedActiveUpgrade?.metrics, {});
  const activeUpgradeSourceObjectKey = first.version.objectKey;
  assert.ok(activeUpgradeSourceObjectKey);
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          metrics: {
            provider: "amazon-bedrock-data-automation",
            bdaInvocationArn: "arn:aws:bedrock:failed-invocation",
            bdaInvocationState: "terminal",
            bdaTerminalStatus: "ServiceError",
            bdaSourceObjectKey: activeUpgradeSourceObjectKey,
            bdaOutputPrefix: "repositories/1/artifacts/version/bda/runs/old/",
            bdaResultObjectKey: "repositories/1/artifacts/version/bda/partial.json",
            waitReason: "AWAITING_MEDIA_ANALYSIS",
            waitStartedAt: "2026-07-22T12:00:00.000Z",
          },
        })
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id)),
    "smoke.unifiedContent.seedFailedManagedServiceState"
  );
  const providerFailureAt = new Date(Date.now() + 180_000);
  assert.deepEqual(
    await recordRepositoryProcessingFailure(
      {
        jobId: first.inspectJob.id,
        itemVersionId: first.version.id,
      },
      {
        terminal: false,
        code: "BDA_JOB_FAILED",
        message: "simulated failed BDA invocation",
        resetManagedService: "bedrock-data-automation",
      },
      { now: providerFailureAt, retryDelaySeconds: () => 5 }
    ),
    { action: "retry", delaySeconds: 5 }
  );
  const [resetProviderRun] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryProcessingJobs.status,
          metrics: repositoryProcessingJobs.metrics,
          startedAt: repositoryProcessingJobs.startedAt,
        })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readResetManagedServiceState"
  );
  assert.equal(resetProviderRun?.status, "pending");
  assert.deepEqual(resetProviderRun?.metrics, {
    provider: "amazon-bedrock-data-automation",
  });
  assert.equal(resetProviderRun?.startedAt?.toISOString(), providerFailureAt.toISOString());
  const reclaimedAfterProviderFailure = await claimRepositoryProcessingJob(
    {
      jobId: first.inspectJob.id,
      itemVersionId: first.version.id,
    },
    "unified-content-smoke-provider-retry",
    { now: new Date(providerFailureAt.getTime() + 6_000) }
  );
  assert.equal(reclaimedAfterProviderFailure?.status, "running");
  assert.equal(reclaimedAfterProviderFailure?.attempt, 2);
  assert.deepEqual(
    await recordRepositoryProcessingFailure(
      {
        jobId: first.inspectJob.id,
        itemVersionId: first.version.id,
      },
      {
        terminal: true,
        code: "INVALID_SOURCE_CONTENT",
        message: "simulated terminal background-upgrade failure",
      },
      { now: new Date(), retryDelaySeconds: () => 5 }
    ),
    { action: "terminal", code: "INVALID_SOURCE_CONTENT" }
  );
  const [activeFailureState] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          versionStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          itemStatus: repositoryItems.processingStatus,
          itemError: repositoryItems.processingError,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readActiveUpgradeFailureState"
  );
  assert.deepEqual(activeFailureState, {
    jobStatus: "failed",
    versionStatus: "completed",
    storageStatus: "available",
    inspectionStatus: "clean",
    itemStatus: "embedded",
    itemError: null,
  });
  assert.equal(
    await claimRepositoryProcessingJob(
      {
        jobId: first.inspectJob.id,
        itemVersionId: first.version.id,
      },
      "unified-content-smoke-stale-terminal-delivery",
      { now: new Date(Date.now() + 24 * 60 * 60_000) }
    ),
    null
  );
  assert.equal(
    (
      await keywordSearch("district emergency", {
        repositoryId: repository.id,
        canonicalOnly: true,
      })
    ).length,
    1
  );
  const activeRetry = await retryCanonicalRepositoryItem(
    item.id,
    "unified-content-smoke-active-retry"
  );
  assert.equal(activeRetry.itemVersionId, first.version.id);
  const [activeRetryState] = await executeQuery(
    (db) =>
      db
        .select({
          jobStatus: repositoryProcessingJobs.status,
          jobAttempt: repositoryProcessingJobs.attempt,
          versionStatus: repositoryItemVersions.processingStatus,
          storageStatus: repositoryItemVersions.storageStatus,
          inspectionStatus: repositoryItemVersions.inspectionStatus,
          itemStatus: repositoryItems.processingStatus,
          itemError: repositoryItems.processingError,
        })
        .from(repositoryProcessingJobs)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryProcessingJobs.itemVersionId)
        )
        .innerJoin(
          repositoryItems,
          eq(repositoryItems.currentVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryProcessingJobs.id, first.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readActiveRetryState"
  );
  assert.deepEqual(activeRetryState, {
    jobStatus: "pending",
    jobAttempt: 0,
    versionStatus: "completed",
    storageStatus: "available",
    inspectionStatus: "clean",
    itemStatus: "embedded",
    itemError: null,
  });

  const [supersededUnsafeVersion] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemVersions)
        .values({
          itemId: item.id,
          versionNumber: 2,
          sourceKind: "upload",
          sourceRevision: "s3:superseded-security-smoke",
          objectKey: `repositories/${repository.id}/44444444-5555-4666-8777-888888888888/unsafe-old.pdf`,
          declaredContentType: "application/pdf",
          byteSize: 4096,
          storageStatus: "quarantined",
          inspectionStatus: "pending",
          processingStatus: "processing",
          processorVersion: "unified-content-v1",
          createdBy: owner.id,
        })
        .returning({ id: repositoryItemVersions.id }),
    "smoke.unifiedContent.createSupersededUnsafeVersion"
  );
  assert.ok(supersededUnsafeVersion);
  const [supersededUnsafeJob] = await executeQuery(
    (db) =>
      db
        .insert(repositoryProcessingJobs)
        .values({
          itemVersionId: supersededUnsafeVersion.id,
          stage: "inspect",
          status: "running",
          idempotencyKey: `${supersededUnsafeVersion.id}:inspect:security-smoke`,
          attempt: 1,
          maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
        })
        .returning({ id: repositoryProcessingJobs.id }),
    "smoke.unifiedContent.createSupersededUnsafeJob"
  );
  assert.ok(supersededUnsafeJob);
  await assert.rejects(
    recordRepositorySecurityBlock(
      {
        jobId: first.inspectJob.id,
        itemVersionId: supersededUnsafeVersion.id,
      },
      "THREATS_FOUND"
    ),
    /does not match its item version/
  );
  await recordRepositorySecurityBlock(
    {
      jobId: supersededUnsafeJob.id,
      itemVersionId: supersededUnsafeVersion.id,
    },
    "THREATS_FOUND",
    new Date("2026-07-22T22:00:00.000Z")
  );
  const [supersededSecurityState] = await executeQuery(
    (db) =>
      db
        .select({
          itemLifecycle: repositoryItems.lifecycleStatus,
          itemStatus: repositoryItems.processingStatus,
          currentVersionId: repositoryItems.currentVersionId,
          unsafeStorage: repositoryItemVersions.storageStatus,
          unsafeInspection: repositoryItemVersions.inspectionStatus,
          jobStatus: repositoryProcessingJobs.status,
          jobErrorCode: repositoryProcessingJobs.lastErrorCode,
        })
        .from(repositoryItems)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, supersededUnsafeVersion.id)
        )
        .innerJoin(
          repositoryProcessingJobs,
          eq(repositoryProcessingJobs.id, supersededUnsafeJob.id)
        )
        .where(eq(repositoryItems.id, item.id))
        .limit(1),
    "smoke.unifiedContent.readSupersededSecurityState"
  );
  assert.deepEqual(supersededSecurityState, {
    itemLifecycle: "active",
    itemStatus: "embedded",
    currentVersionId: first.version.id,
    unsafeStorage: "blocked",
    unsafeInspection: "blocked",
    jobStatus: "failed",
    jobErrorCode: "SECURITY_INSPECTION_BLOCKED",
  });

  const [runtimeFailureItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "Bundled PDF runtime recovery smoke",
          source: `repositories/${repository.id}/33333333-4444-4555-8666-777777777777/runtime.pdf`,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createBundledPdfFailureItem"
  );
  assert.ok(runtimeFailureItem);
  const runtimeFailure = await registerCanonicalUpload({
    itemId: runtimeFailureItem.id,
    userId: owner.id,
    objectKey: `repositories/${repository.id}/33333333-4444-4555-8666-777777777777/runtime.pdf`,
    originalFileName: "runtime.pdf",
    declaredContentType: "application/pdf",
    byteSize: 4096,
    traceId: "unified-content-bundled-pdf-failure",
  });
  await executeQuery(
    (db) =>
      db.execute(sql`
        WITH failed_job AS (
          UPDATE repository_processing_jobs
          SET status = 'failed',
              attempt = 5,
              max_attempts = 5,
              last_error_code = 'RETRY_BUDGET_EXHAUSTED',
              last_error_message = 'PDFParse2 is not a constructor',
              metrics = '{}'::jsonb,
              finished_at = now(),
              updated_at = now()
          WHERE id = ${runtimeFailure.inspectJob.id}::uuid
          RETURNING item_version_id
        ), failed_version AS (
          UPDATE repository_item_versions
          SET inspection_status = 'error', processing_status = 'failed'
          WHERE id IN (SELECT item_version_id FROM failed_job)
          RETURNING item_id
        )
        UPDATE repository_items
        SET processing_status = 'failed',
            processing_error = 'PDFParse2 is not a constructor'
        WHERE id IN (SELECT item_id FROM failed_version)
      `),
    "smoke.unifiedContent.createBundledPdfFailureState"
  );
  await applyArtifactStateRecovery(
    "smoke.unifiedContent.applyBundledPdfArtifactRecovery"
  );
  const [quarantinedPdfFailure] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryProcessingJobs.status,
          attempt: repositoryProcessingJobs.attempt,
          maxAttempts: repositoryProcessingJobs.maxAttempts,
          availableAt: sql<string>`${repositoryProcessingJobs.availableAt}::text`,
          marker: repositoryProcessingJobs.postDeployRecovery,
          metrics: repositoryProcessingJobs.metrics,
        })
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, runtimeFailure.inspectJob.id))
        .limit(1),
    "smoke.unifiedContent.readBundledPdfQuarantine"
  );
  assert.deepEqual(quarantinedPdfFailure, {
    status: "cancelled",
    attempt: 0,
    maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
    availableAt: "infinity",
    marker: POST_DEPLOY_ARTIFACT_RECOVERY_MARKER,
    metrics: {
      postDeployRecovery: POST_DEPLOY_ARTIFACT_RECOVERY_MARKER,
    },
  });
  assert.deepEqual(
    await releasePostDeployRecoveryJobs({
      graceMinutes: 0,
      now: new Date(Date.now() + 60_000),
    }),
    [
      {
        id: runtimeFailure.inspectJob.id,
        itemVersionId: runtimeFailure.version.id,
      },
    ]
  );

  const retrievalV2Result = await retrieveRepositoryContent({
    query: "district emergency",
    repositoryIds: [repository.id],
    userCognitoSub: "e2e-test-user",
    mode: "keyword",
    rerank: false,
  });
  assert.equal(retrievalV2Result.results.length, 1);
  assert.equal(
    retrievalV2Result.results[0]?.generationId,
    publication.generationId
  );
  assert.equal(
    retrievalV2Result.results[0]?.citations[0]?.itemVersionId,
    first.version.id
  );
  assert.equal(
    retrievalV2Result.results[0]?.citations[0]?.sourceLocator.page,
    1
  );

  await executeQuery(
    (db) =>
      db
        .update(repositoryItemChunks)
        .set({ accessScope: { userIds: [] } })
        .where(eq(repositoryItemChunks.itemVersionId, first.version.id)),
    "smoke.unifiedContent.restrictSegments"
  );
  const deniedSegmentResult = await retrieveRepositoryContent({
    query: "district emergency",
    repositoryIds: [repository.id],
    userCognitoSub: "e2e-test-user",
    mode: "keyword",
    rerank: false,
  });
  assert.equal(deniedSegmentResult.results.length, 0);
  await executeQuery(
    (db) =>
      db
        .update(repositoryItemChunks)
        .set({ accessScope: {} })
        .where(eq(repositoryItemChunks.itemVersionId, first.version.id)),
    "smoke.unifiedContent.restoreSegmentAccess"
  );

  const citationResults = await keywordSearch("district emergency", {
    repositoryId: repository.id,
    canonicalOnly: true,
  });
  assert.equal(citationResults.length, 1);
  assert.equal(citationResults[0]?.citation?.sourceLocator.page, 1);
  assert.equal(citationResults[0]?.citation?.itemVersionId, first.version.id);

  await executeQuery(
    (db) =>
      db.insert(repositoryItemChunks).values({
        itemId: item.id,
        content: "canonical isolation sentinel",
        chunkIndex: 99,
        metadata: { legacy: true },
      }),
    "smoke.unifiedContent.legacyChunk"
  );
  const isolatedResults = await keywordSearch("canonical isolation sentinel", {
    repositoryId: repository.id,
    canonicalOnly: true,
  });
  assert.equal(isolatedResults.length, 0);

  const [legacyOnlyItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "text",
          name: "Legacy compatibility smoke",
          source: "text_input",
          processingStatus: "completed",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createLegacyOnlyItem"
  );
  assert.ok(legacyOnlyItem);
  await executeQuery(
    (db) =>
      db.insert(repositoryItemChunks).values({
        itemId: legacyOnlyItem.id,
        content:
          "ORCHID-COMPASS-SMOKE uses the silver lighthouse protocol",
        chunkIndex: 0,
        metadata: { source: "text_input" },
      }),
    "smoke.unifiedContent.createLegacyOnlyChunk"
  );
  const compatibilityResults = await retrieveRepositoryContent({
    query: "ORCHID-COMPASS-SMOKE",
    repositoryIds: [repository.id],
    userCognitoSub: "e2e-test-user",
    mode: "keyword",
    rerank: false,
  });
  assert.equal(compatibilityResults.results.length, 1);
  assert.equal(compatibilityResults.results[0]?.itemId, legacyOnlyItem.id);
  assert.equal(compatibilityResults.results[0]?.versionNumber, 0);
  assert.equal(
    compatibilityResults.results[0]?.citations[0]?.label,
    "Legacy compatibility smoke"
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryItemChunks)
        .set({ accessScope: { userIds: [] } })
        .where(eq(repositoryItemChunks.itemId, legacyOnlyItem.id)),
    "smoke.unifiedContent.restrictLegacyCompatibilitySegment"
  );
  const deniedCompatibilityResults = await retrieveRepositoryContent({
    query: "ORCHID-COMPASS-SMOKE",
    repositoryIds: [repository.id],
    userCognitoSub: "e2e-test-user",
    mode: "keyword",
    rerank: false,
  });
  assert.equal(deniedCompatibilityResults.results.length, 0);
  await executeQuery(
    (db) =>
      db
        .update(repositoryItemChunks)
        .set({ accessScope: {} })
        .where(eq(repositoryItemChunks.itemId, legacyOnlyItem.id)),
    "smoke.unifiedContent.restoreLegacyCompatibilitySegment"
  );

  const [textItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "text",
          name: "Canonical text smoke",
          source: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/reference.txt`,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createTextItem"
  );
  assert.ok(textItem);
  const textRegistration = await registerCanonicalUpload({
    itemId: textItem.id,
    userId: owner.id,
    objectKey: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/reference.txt`,
    originalFileName: "reference.txt",
    declaredContentType: "text/plain",
    byteSize: 64,
    traceId: "unified-content-text-smoke",
  });
  const textExtraction = extractCanonicalTextDocument(
    Buffer.from("MOONLIT-HARBOR-SMOKE uses the indigo compass procedure."),
    "text/plain",
    "reference.txt"
  );
  const textPublication = await publishDocumentVersion({
    itemVersionId: textRegistration.version.id,
    processorVersion: textExtraction.processorVersion,
    processorName: "aistudio-text",
    detectedContentType: textExtraction.detectedContentType,
    inspectionStatus: "clean",
    malwareScanRequired: true,
    canonicalText: textExtraction.canonicalText,
    segments: textExtraction.segments,
    artifactMetadata: textExtraction.metadata,
  });
  const canonicalTextResults = await retrieveRepositoryContent({
    query: "MOONLIT-HARBOR-SMOKE",
    repositoryIds: [repository.id],
    userCognitoSub: "e2e-test-user",
    mode: "keyword",
    rerank: false,
  });
  assert.equal(canonicalTextResults.results.length, 1);
  assert.equal(
    canonicalTextResults.results[0]?.generationId,
    textPublication.generationId
  );
  assert.equal(
    canonicalTextResults.results[0]?.citations[0]?.label,
    "reference.txt"
  );

  const [officeItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "directory.xlsx",
          source: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/directory.xlsx`,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createOfficeItem"
  );
  assert.ok(officeItem);
  const officeRegistration = await registerCanonicalUpload({
    itemId: officeItem.id,
    userId: owner.id,
    objectKey: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/directory.xlsx`,
    originalFileName: "directory.xlsx",
    declaredContentType: OFFICE_CONTENT_TYPES.xlsx,
    byteSize: 4096,
    traceId: "unified-content-office-smoke",
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["School", "Emergency Extension"],
      ["Harbor Heights", "4100"],
    ]),
    "Directory"
  );
  const workbookBytes = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Uint8Array;
  const officeExtraction = await extractOfficeDocument(
    workbookBytes,
    OFFICE_CONTENT_TYPES.xlsx
  );
  const officePublication = await publishDocumentVersion({
    itemVersionId: officeRegistration.version.id,
    processorVersion: officeExtraction.processorVersion,
    processorName: "aistudio-office",
    detectedContentType: officeExtraction.detectedContentType,
    inspectionStatus: "clean",
    malwareScanRequired: true,
    canonicalText: officeExtraction.canonicalText,
    segments: officeExtraction.segments,
    artifactMetadata: officeExtraction.metadata,
  });
  const officePublicationReplay = await publishDocumentVersion({
    itemVersionId: officeRegistration.version.id,
    processorVersion: officeExtraction.processorVersion,
    processorName: "aistudio-office",
    detectedContentType: officeExtraction.detectedContentType,
    inspectionStatus: "clean",
    malwareScanRequired: true,
    canonicalText: officeExtraction.canonicalText,
    segments: officeExtraction.segments,
  });
  assert.equal(officePublication.replayed, false);
  assert.equal(officePublicationReplay.replayed, true);
  assert.equal(officePublicationReplay.generationId, officePublication.generationId);
  const officeResults = await keywordSearch("Harbor Heights", {
    repositoryId: repository.id,
    canonicalOnly: true,
  });
  assert.equal(officeResults.length, 1);
  assert.equal(officeResults[0]?.citation?.sourceLocator.sheet, "Directory");
  assert.equal(officeResults[0]?.citation?.sourceLocator.cellRange, "A1:B2");
  const carriedForwardPdfResults = await keywordSearch("district emergency", {
    repositoryId: repository.id,
    canonicalOnly: true,
  });
  assert.equal(carriedForwardPdfResults.length, 1);
  assert.equal(carriedForwardPdfResults[0]?.citation?.sourceLocator.page, 1);

  const [imageItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "image",
          name: "evacuation-map.png",
          source: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/evacuation-map.png`,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createImageItem"
  );
  assert.ok(imageItem);
  const imageRegistration = await registerCanonicalUpload({
    itemId: imageItem.id,
    userId: owner.id,
    objectKey: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/evacuation-map.png`,
    originalFileName: "evacuation-map.png",
    declaredContentType: "image/png",
    byteSize: 1024,
    traceId: "unified-content-image-smoke",
  });
  const imageDocument = buildImageSearchDocument({
    caption: "A school evacuation map with a marked assembly area.",
    ocrLines: [
      {
        text: "ASSEMBLY AREA",
        region: { x: 0.55, y: 0.65, width: 0.3, height: 0.1 },
      },
    ],
    width: 1600,
    height: 900,
    detectedContentType: "image/png",
  });
  const imagePublicationInput = {
    itemVersionId: imageRegistration.version.id,
    processorVersion: IMAGE_PROCESSOR_VERSION,
    processorName: "aistudio-image",
    detectedContentType: "image/png",
    inspectionStatus: "clean" as const,
    malwareScanRequired: true,
    canonicalText: imageDocument.canonicalText,
    segments: imageDocument.segments,
    additionalArtifacts: [
      {
        kind: "image" as const,
        mediaType: "image/png",
        objectKey: `repositories/${repository.id}/11111111-2222-4333-8444-555555555555/evacuation-map.png`,
        sha256: "a".repeat(64),
      },
      {
        kind: "thumbnail" as const,
        mediaType: "image/jpeg",
        objectKey: `repositories/${repository.id}/artifacts/${imageRegistration.version.id}/thumbnail.jpg`,
        sha256: "b".repeat(64),
      },
      {
        kind: "caption" as const,
        mediaType: "text/plain",
        textInline: "A school evacuation map with a marked assembly area.",
      },
      {
        kind: "layout" as const,
        mediaType: "text/plain",
        textInline: imageDocument.ocrText,
        sourceRegions: imageDocument.ocrRegions,
      },
    ],
    embeddingModel: "amazon-bedrock:amazon.titan-embed-text-v1",
    embeddingDimensions: 1536,
    visualEmbeddingModel: "amazon-bedrock:cohere.embed-v4:0",
    visualEmbeddingDimensions: 1536,
    segmentationVersion: "retrieval-v2",
  };
  const imagePublication = await publishDocumentVersion(imagePublicationInput);
  const imageReplay = await publishDocumentVersion(imagePublicationInput);
  assert.equal(imagePublication.replayed, false);
  assert.equal(imageReplay.replayed, true);
  assert.equal(imageReplay.generationId, imagePublication.generationId);
  const [beforeEmbeddingActivation] = await executeQuery(
    (db) =>
      db
        .select({
          activeGenerationId: knowledgeRepositories.activeIndexGenerationId,
        })
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, repository.id))
        .limit(1),
    "smoke.unifiedContent.beforeEmbeddingActivation"
  );
  assert.equal(
    beforeEmbeddingActivation?.activeGenerationId,
    officePublication.generationId
  );
  const imageArtifacts = await executeQuery(
    (db) =>
      db
        .select({ kind: repositoryArtifacts.kind })
        .from(repositoryArtifacts)
        .where(
          eq(repositoryArtifacts.itemVersionId, imageRegistration.version.id)
        ),
    "smoke.unifiedContent.imageArtifacts"
  );
  assert.deepEqual(
    imageArtifacts.map((artifact) => artifact.kind).sort(),
    ["canonical_text", "caption", "image", "layout", "thumbnail"]
  );
  const imageResultsBeforeActivation = await keywordSearch("marked assembly", {
    repositoryId: repository.id,
    canonicalOnly: true,
  });
  assert.equal(imageResultsBeforeActivation.length, 0);
  const activationExecutor: GenerationActivationExecutor = async (plan) => {
    const rows = await executeTransaction(
      async (tx) => {
        // The Lambda package has its own dependency boundary, so bridge its
        // structurally identical Drizzle SQL objects into the app workspace.
        await tx.execute(plan.lockRepository as unknown as SQL);
        await tx.execute(plan.supersedeCurrent as unknown as SQL);
        await tx.execute(plan.activateTarget as unknown as SQL);
        return tx.execute(plan.publishTarget as unknown as SQL);
      },
      "smoke.unifiedContent.activateEmbeddedGeneration"
    );
    return rows as unknown as GenerationActivationResult[];
  };
  const incompleteActivation = await activateCompletedGeneration(
    imagePublication.generationId,
    activationExecutor
  );
  assert.equal(incompleteActivation, null);
  const firstEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 11 * 60_000),
    });
  assert.ok(
    firstEmbeddingRecoveryClaim.some(
      (generation) => generation.id === imagePublication.generationId
    )
  );
  const duplicateEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 12 * 60_000),
    });
  assert.equal(
    duplicateEmbeddingRecoveryClaim.some(
      (generation) => generation.id === imagePublication.generationId
    ),
    false
  );

  const smokeVector = `[${Array.from({ length: 1536 }, () => "0.001").join(",")}]`;
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = ${smokeVector}::vector
        WHERE index_generation_id = ${imagePublication.generationId}::uuid
      `),
    "smoke.unifiedContent.completeTextEmbeddings"
  );
  const missingVisualActivation = await activateCompletedGeneration(
    imagePublication.generationId,
    activationExecutor
  );
  assert.equal(missingVisualActivation, null);

  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET visual_embedding = ${smokeVector}::vector
        WHERE index_generation_id = ${imagePublication.generationId}::uuid
          AND modality IN ('image', 'video')
      `),
    "smoke.unifiedContent.completeVisualEmbeddings"
  );
  const activation = await activateCompletedGeneration(
    imagePublication.generationId,
    activationExecutor
  );
  assert.equal(activation?.repository_id, repository.id);
  assert.ok((activation?.embedded_item_count ?? 0) >= 3);
  const replayedActivation = await activateCompletedGeneration(
    imagePublication.generationId,
    activationExecutor
  );
  assert.equal(replayedActivation?.repository_id, repository.id);
  assert.equal(
    replayedActivation?.embedded_item_count,
    activation?.embedded_item_count
  );
  const [activeLegacyItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "text",
          name: "Active legacy inline policy",
          source: "Active legacy source remains searchable during recovery.",
          processingStatus: "embedded",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createActiveLegacyInlineItem"
  );
  assert.ok(activeLegacyItem);
  const [activeLegacyVersion] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemVersions)
        .values({
          itemId: activeLegacyItem.id,
          versionNumber: 1,
          sourceKind: "text",
          sourceRevision: "inline:active-legacy-smoke",
          objectKey: `repositories/${repository.id}/legacy/active-inline.txt`,
          declaredContentType: "text/plain",
          byteSize: 56,
          storageStatus: "available",
          inspectionStatus: "clean",
          processingStatus: "completed",
          processorVersion: "structured-text-v1",
          createdBy: owner.id,
        })
        .returning({ id: repositoryItemVersions.id }),
    "smoke.unifiedContent.createActiveLegacyInlineVersion"
  );
  assert.ok(activeLegacyVersion);
  await executeQuery(
    (db) =>
      db
        .update(repositoryItems)
        .set({ currentVersionId: activeLegacyVersion.id })
        .where(eq(repositoryItems.id, activeLegacyItem.id)),
    "smoke.unifiedContent.attachActiveLegacyInlineVersion"
  );
  const [activeLegacyJob] = await executeQuery(
    (db) =>
      db
        .insert(repositoryProcessingJobs)
        .values({
          itemVersionId: activeLegacyVersion.id,
          stage: "inspect",
          status: "failed",
          idempotencyKey: `${activeLegacyVersion.id}:inspect:active-legacy-smoke`,
          attempt: CONTENT_PROCESSING_MAX_ATTEMPTS,
          maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
          lastErrorCode: "LEGACY_INLINE_SOURCE",
        })
        .returning({ id: repositoryProcessingJobs.id }),
    "smoke.unifiedContent.createActiveLegacyInlineJob"
  );
  assert.ok(activeLegacyJob);
  const [activeLegacyChunk] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemChunks)
        .values({
          itemId: activeLegacyItem.id,
          itemVersionId: activeLegacyVersion.id,
          indexGenerationId: imagePublication.generationId,
          content: "Active legacy source remains searchable during recovery.",
          chunkIndex: 0,
          metadata: {},
          modality: "text",
          contentHash: "f".repeat(64),
          sourceLocator: { headingPath: ["Active legacy inline policy"] },
          contextPrefix: "Active legacy inline policy",
          segmentLevel: "section",
          accessScope: {},
          tokens: 8,
        })
        .returning({ id: repositoryItemChunks.id }),
    "smoke.unifiedContent.createActiveLegacyInlineChunk"
  );
  assert.ok(activeLegacyChunk);
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = ${smokeVector}::vector
        WHERE id = ${activeLegacyChunk.id}
      `),
    "smoke.unifiedContent.embedActiveLegacyInlineChunk"
  );
  const activeLegacyClaim = (
    await claimLegacyInlineTextRecoveries({
      leaseOwner: "legacy-inline-smoke:active",
      repositoryId: repository.id,
      now: new Date(Date.now() + 60_000),
    })
  ).find((claim) => claim.jobId === activeLegacyJob.id);
  assert.ok(activeLegacyClaim);
  const activeLegacyObjectKey = buildRepositorySourceObjectKey(
    repository.id,
    `inline-${activeLegacyItem.id}.txt`,
    activeLegacyVersion.id
  );
  assert.equal(
    await completeLegacyInlineTextRecovery({
      claim: activeLegacyClaim,
      objectKey: activeLegacyObjectKey,
      byteSize: Buffer.byteLength(activeLegacyClaim.content, "utf8"),
      sha256: "b".repeat(64),
    }),
    true
  );
  const [activeLegacyRecoveryState] = await executeQuery(
    (db) =>
      db
        .select({
          itemSource: repositoryItems.source,
          itemStatus: repositoryItems.processingStatus,
          versionStorage: repositoryItemVersions.storageStatus,
          versionInspection: repositoryItemVersions.inspectionStatus,
          versionStatus: repositoryItemVersions.processingStatus,
          jobStatus: repositoryProcessingJobs.status,
        })
        .from(repositoryItems)
        .innerJoin(
          repositoryItemVersions,
          eq(repositoryItemVersions.id, repositoryItems.currentVersionId)
        )
        .innerJoin(
          repositoryProcessingJobs,
          eq(repositoryProcessingJobs.itemVersionId, repositoryItemVersions.id)
        )
        .where(eq(repositoryItems.id, activeLegacyItem.id))
        .limit(1),
    "smoke.unifiedContent.readActiveLegacyRecoveryState"
  );
  assert.deepEqual(activeLegacyRecoveryState, {
    itemSource: activeLegacyObjectKey,
    itemStatus: "embedded",
    versionStorage: "available",
    versionInspection: "clean",
    versionStatus: "completed",
    jobStatus: "pending",
  });
  assert.equal(
    (
      await keywordSearch("active legacy source", {
        repositoryId: repository.id,
        canonicalOnly: true,
      })
    ).some((result) => result.itemId === activeLegacyItem.id),
    true
  );
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = NULL
        WHERE id = (
          SELECT min(chunk.id)
          FROM repository_item_chunks chunk
          WHERE chunk.index_generation_id = ${imagePublication.generationId}::uuid
        )
      `),
    "smoke.unifiedContent.createIncompleteActiveGeneration"
  );
  const activeEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 22 * 60_000),
    });
  assert.ok(
    activeEmbeddingRecoveryClaim.some(
      (generation) => generation.id === imagePublication.generationId
    )
  );
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = ${smokeVector}::vector
        WHERE index_generation_id = ${imagePublication.generationId}::uuid
          AND embedding IS NULL
      `),
    "smoke.unifiedContent.restoreActiveGenerationEmbeddings"
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      imagePublication.generationId
    ),
    true
  );
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = NULL
        WHERE id = (
          SELECT min(chunk.id)
          FROM repository_item_chunks chunk
          WHERE chunk.index_generation_id = ${imagePublication.generationId}::uuid
        )
      `),
    "smoke.unifiedContent.recreateIncompleteActiveGeneration"
  );
  const finalActiveEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 33 * 60_000),
    });
  assert.ok(
    finalActiveEmbeddingRecoveryClaim.some(
      (generation) => generation.id === imagePublication.generationId
    )
  );
  const exhaustedActiveEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 44 * 60_000),
    });
  assert.equal(
    exhaustedActiveEmbeddingRecoveryClaim.some(
      (generation) => generation.id === imagePublication.generationId
    ),
    false
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      imagePublication.generationId
    ),
    false
  );
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = ${smokeVector}::vector
        WHERE index_generation_id = ${imagePublication.generationId}::uuid
          AND embedding IS NULL
      `),
    "smoke.unifiedContent.restoreExhaustedActiveGeneration"
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      imagePublication.generationId
    ),
    true
  );
  const [activationOnlyGeneration] = await executeQuery(
    (db) =>
      db
        .insert(repositoryIndexGenerations)
        .values({
          repositoryId: repository.id,
          status: "failed",
          embeddingModel: "amazon-bedrock:amazon.titan-embed-text-v1",
          embeddingDimensions: 1536,
          processorVersion: "activation-only-recovery-smoke",
          errorMessage: "simulated activation transaction failure",
        })
        .returning({ id: repositoryIndexGenerations.id }),
    "smoke.unifiedContent.createActivationOnlyGeneration"
  );
  assert.ok(activationOnlyGeneration);
  const [activationOnlyChunk] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemChunks)
        .values({
          itemId: imageItem.id,
          itemVersionId: imageRegistration.version.id,
          indexGenerationId: activationOnlyGeneration.id,
          content: "fully embedded activation recovery sentinel",
          chunkIndex: 0,
          metadata: {},
          modality: "text",
          contentHash: "a".repeat(64),
          sourceLocator: {},
          contextPrefix: "",
          segmentLevel: "chunk",
          accessScope: {},
          tokens: 5,
        })
        .returning({ id: repositoryItemChunks.id }),
    "smoke.unifiedContent.createActivationOnlyChunk"
  );
  assert.ok(activationOnlyChunk);
  await executeQuery(
    (db) =>
      db.execute(sql`
        UPDATE repository_item_chunks
        SET embedding = ${smokeVector}::vector
        WHERE id = ${activationOnlyChunk.id}
      `),
    "smoke.unifiedContent.completeActivationOnlyEmbedding"
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      activationOnlyGeneration.id
    ),
    false
  );
  const activationOnlyClaims = await claimIncompleteEmbeddingGenerations({
    now: new Date(Date.now() + 55 * 60_000),
  });
  const activationOnlyClaim = activationOnlyClaims.find(
    (generation) => generation.id === activationOnlyGeneration.id
  );
  assert.ok(activationOnlyClaim);
  assert.equal(activationOnlyClaim.visualEmbeddingEnabled, false);
  assert.equal(activationOnlyClaim.activationOnly, true);
  assert.equal(activationOnlyClaim.previousStatus, "failed");
  assert.equal(
    activationOnlyClaim.previousErrorMessage,
    "simulated activation transaction failure"
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      activationOnlyGeneration.id
    ),
    true
  );
  await releaseIncompleteEmbeddingGenerationClaim(
    activationOnlyClaim
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      activationOnlyGeneration.id
    ),
    false
  );
  const reclaimedActivationOnly = await claimIncompleteEmbeddingGenerations({
    now: new Date(Date.now() + 56 * 60_000),
  });
  const reclaimedActivationOnlyClaim = reclaimedActivationOnly.find(
    (generation) => generation.id === activationOnlyGeneration.id
  );
  assert.ok(reclaimedActivationOnlyClaim);
  assert.equal(reclaimedActivationOnlyClaim.visualEmbeddingEnabled, false);
  assert.equal(reclaimedActivationOnlyClaim.activationOnly, true);
  assert.equal(reclaimedActivationOnlyClaim.previousStatus, "failed");
  await executeQuery(
    (db) =>
      db
        .update(repositoryIndexGenerations)
        .set({ status: "superseded" })
        .where(eq(repositoryIndexGenerations.id, activationOnlyGeneration.id)),
    "smoke.unifiedContent.finishActivationOnlyContract"
  );
  const [failedEmbeddingGeneration] = await executeQuery(
    (db) =>
      db
        .insert(repositoryIndexGenerations)
        .values({
          repositoryId: repository.id,
          status: "failed",
          embeddingModel: "amazon-bedrock:amazon.titan-embed-text-v1",
          embeddingDimensions: 1536,
          processorVersion: "embedding-recovery-smoke",
          errorMessage: "simulated provider outage",
        })
        .returning({ id: repositoryIndexGenerations.id }),
    "smoke.unifiedContent.createFailedEmbeddingGeneration"
  );
  assert.ok(failedEmbeddingGeneration);
  await executeQuery(
    (db) =>
      db.insert(repositoryItemChunks).values({
        itemId: imageItem.id,
        itemVersionId: imageRegistration.version.id,
        indexGenerationId: failedEmbeddingGeneration.id,
        content: "failed embedding recovery sentinel",
        chunkIndex: 0,
        metadata: {},
        modality: "text",
        contentHash: "c".repeat(64),
        sourceLocator: {},
        contextPrefix: "",
        segmentLevel: "chunk",
        accessScope: {},
        tokens: 4,
      }),
    "smoke.unifiedContent.createFailedEmbeddingChunk"
  );
  const failedEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 33 * 60_000),
    });
  assert.ok(
    failedEmbeddingRecoveryClaim.some(
      (generation) => generation.id === failedEmbeddingGeneration.id
    )
  );
  const [reopenedEmbeddingGeneration] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryIndexGenerations.status,
          attempts: repositoryIndexGenerations.embeddingRecoveryAttempts,
          errorMessage: repositoryIndexGenerations.errorMessage,
        })
        .from(repositoryIndexGenerations)
        .where(eq(repositoryIndexGenerations.id, failedEmbeddingGeneration.id))
        .limit(1),
    "smoke.unifiedContent.readReopenedEmbeddingGeneration"
  );
  assert.deepEqual(reopenedEmbeddingGeneration, {
    status: "building",
    attempts: 1,
    errorMessage: null,
  });
  const claimedFailedEmbeddingGeneration = failedEmbeddingRecoveryClaim.find(
    (generation) => generation.id === failedEmbeddingGeneration.id
  );
  assert.ok(claimedFailedEmbeddingGeneration);
  assert.equal(
    await releaseIncompleteEmbeddingGenerationClaim(
      claimedFailedEmbeddingGeneration
    ),
    true
  );
  const [releasedEmbeddingRecoveryClaim] = await executeQuery(
    (db) =>
      db
        .select({
          status: repositoryIndexGenerations.status,
          attempts: repositoryIndexGenerations.embeddingRecoveryAttempts,
          queuedAt: repositoryIndexGenerations.embeddingRecoveryQueuedAt,
          errorMessage: repositoryIndexGenerations.errorMessage,
        })
        .from(repositoryIndexGenerations)
        .where(eq(repositoryIndexGenerations.id, failedEmbeddingGeneration.id))
        .limit(1),
    "smoke.unifiedContent.readReleasedEmbeddingRecoveryClaim"
  );
  assert.deepEqual(releasedEmbeddingRecoveryClaim, {
    status: "failed",
    attempts: 1,
    queuedAt: null,
    errorMessage: "simulated provider outage",
  });
  const reclaimedEmbeddingRecovery =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 34 * 60_000),
    });
  const reclaimedFailedEmbeddingGeneration = reclaimedEmbeddingRecovery.find(
    (generation) => generation.id === failedEmbeddingGeneration.id
  );
  assert.ok(reclaimedFailedEmbeddingGeneration);
  assert.equal(reclaimedFailedEmbeddingGeneration.previousStatus, "failed");
  // The previous invocation cannot release this newer timestamp-fenced claim.
  assert.equal(
    await releaseIncompleteEmbeddingGenerationClaim(
      claimedFailedEmbeddingGeneration
    ),
    false
  );
  assert.equal(
    await releaseIncompleteEmbeddingGenerationClaim(
      reclaimedFailedEmbeddingGeneration
    ),
    true
  );
  const finalFailedEmbeddingRecovery = await claimIncompleteEmbeddingGenerations({
    now: new Date(Date.now() + 35 * 60_000),
  });
  const finalFailedEmbeddingGeneration = finalFailedEmbeddingRecovery.find(
    (generation) => generation.id === failedEmbeddingGeneration.id
  );
  assert.ok(finalFailedEmbeddingGeneration);
  assert.equal(
    await releaseIncompleteEmbeddingGenerationClaim(
      finalFailedEmbeddingGeneration
    ),
    true
  );
  const exhaustedEmbeddingRecoveryClaim =
    await claimIncompleteEmbeddingGenerations({
      now: new Date(Date.now() + 36 * 60_000),
    });
  assert.equal(
    exhaustedEmbeddingRecoveryClaim.some(
      (generation) => generation.id === failedEmbeddingGeneration.id
    ),
    false
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      failedEmbeddingGeneration.id
    ),
    false
  );
  assert.equal(
    await canAcknowledgeCanonicalEmbeddingDlqMessage(
      "11111111-2222-4333-8444-555555555555"
    ),
    true
  );

  const [backgroundEmbeddingGeneration] = await executeQuery(
    (db) =>
      db
        .insert(repositoryIndexGenerations)
        .values({
          repositoryId: repository.id,
          status: "building",
          embeddingModel: "amazon-bedrock:amazon.titan-embed-text-v1",
          embeddingDimensions: 1536,
          processorVersion: "background-embedding-failure-smoke",
        })
        .returning({ id: repositoryIndexGenerations.id }),
    "smoke.unifiedContent.createBackgroundEmbeddingGeneration"
  );
  assert.ok(backgroundEmbeddingGeneration);
  await executeQuery(
    (db) =>
      db.insert(repositoryItemChunks).values({
        itemId: imageItem.id,
        itemVersionId: imageRegistration.version.id,
        indexGenerationId: backgroundEmbeddingGeneration.id,
        content: "background embedding failure sentinel",
        chunkIndex: 0,
        metadata: {},
        modality: "text",
        contentHash: "e".repeat(64),
        sourceLocator: {},
        contextPrefix: "",
        segmentLevel: "chunk",
        accessScope: {},
        tokens: 4,
      }),
    "smoke.unifiedContent.createBackgroundEmbeddingChunk"
  );
  assert.equal(
    await failBuildingGeneration(
      {
        generationId: backgroundEmbeddingGeneration.id,
        itemId: imageItem.id,
        errorMessage: "simulated terminal background embedding failure",
      },
      async (query) =>
        (await executeQuery(
          (db) => db.execute(query as unknown as SQL),
          "smoke.unifiedContent.failBackgroundEmbeddingGeneration"
        )) as unknown as Array<{ item_id: number }>
    ),
    false
  );
  const [preservedEmbeddedItem] = await executeQuery(
    (db) =>
      db
        .select({
          itemStatus: repositoryItems.processingStatus,
          generationStatus: repositoryIndexGenerations.status,
        })
        .from(repositoryItems)
        .innerJoin(
          repositoryIndexGenerations,
          eq(repositoryIndexGenerations.id, backgroundEmbeddingGeneration.id)
        )
        .where(eq(repositoryItems.id, imageItem.id))
        .limit(1),
    "smoke.unifiedContent.readPreservedBackgroundEmbeddingFailure"
  );
  assert.deepEqual(preservedEmbeddedItem, {
    itemStatus: "embedded",
    generationStatus: "failed",
  });
  const imageResults = await keywordSearch("marked assembly", {
    repositoryId: repository.id,
    canonicalOnly: true,
  });
  assert.equal(imageResults.length, 1);
  assert.equal(imageResults[0]?.citation?.sourceLocator.regions?.[0]?.x, 0);

  await assert.rejects(
    executeQuery(
      (db) =>
        db.insert(repositoryIndexGenerations).values({
          repositoryId: repository.id,
          status: "active",
          processorVersion: "conflicting-smoke-generation",
          publishedAt: new Date(),
        }),
      "smoke.unifiedContent.secondActiveGeneration"
    )
  );

  process.stdout.write(
    "unified-content-foundation smoke: PDF, Office, and image publication, citations, idempotency, quarantine, artifacts, and generation guards passed\n"
  );
} finally {
  await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, repository.id)),
    "smoke.unifiedContent.cleanup"
  );
  await closeDatabase();
}
