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
import { eq, sql, type SQL } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import { closeDatabase, executeQuery } from "@/lib/db/drizzle-client";
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
  CONTENT_PROCESSING_MAX_ATTEMPTS,
  DEFAULT_CONTENT_PLATFORM_CONFIG,
  completeRepositoryUpload,
  initiateRepositoryUpload,
  PDF_PROCESSOR_VERSION,
  OFFICE_CONTENT_TYPES,
  IMAGE_PROCESSOR_VERSION,
  publishDocumentVersion,
  publishPdfVersion,
  getCanonicalRepositoryItemStatuses,
  registerCanonicalUpload,
  retryCanonicalRepositoryItem,
  segmentPdfPages,
  type RepositoryUploadStorage,
} from "@/lib/repositories/content-platform";
import { keywordSearch } from "@/lib/repositories/search-service";
import { retrieveRepositoryContent } from "@/lib/repositories/retrieval-v2/service";
import {
  activateCompletedGeneration,
  type GenerationActivationExecutor,
  type GenerationActivationResult,
} from "../../infra/lambdas/embedding-generator/generation-activation";

const pdf = await PDFDocument.create();
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

  const [retryItem] = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: repository.id,
          type: "document",
          name: "retry-reference.pdf",
          source: `repositories/${repository.id}/22222222-3333-4444-8555-666666666666/retry-reference.pdf`,
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id }),
    "smoke.unifiedContent.createRetryItem"
  );
  assert.ok(retryItem);
  const retryRegistration = await registerCanonicalUpload({
    itemId: retryItem.id,
    userId: owner.id,
    objectKey: `repositories/${repository.id}/22222222-3333-4444-8555-666666666666/retry-reference.pdf`,
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
              attempt = max_attempts,
              last_error_message = 'simulated terminal processing failure',
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
  assert.equal(restartedState?.attempt, CONTENT_PROCESSING_MAX_ATTEMPTS);
  assert.equal(
    restartedState?.maxAttempts,
    CONTENT_PROCESSING_MAX_ATTEMPTS * 2
  );
  assert.equal(restartedState?.versionStatus, "pending");
  assert.equal(restartedState?.storageStatus, "quarantined");
  assert.equal(restartedState?.itemStatus, "pending");

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
  const activationExecutor: GenerationActivationExecutor = async (query) => {
    const rows = await executeQuery(
      // The Lambda package has its own dependency boundary, so bridge its
      // structurally identical Drizzle SQL object into the app workspace.
      (db) => db.execute(query as unknown as SQL),
      "smoke.unifiedContent.activateEmbeddedGeneration"
    );
    return rows as unknown as GenerationActivationResult[];
  };
  const incompleteActivation = await activateCompletedGeneration(
    imagePublication.generationId,
    activationExecutor
  );
  assert.equal(incompleteActivation, null);

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
