import type {
  EventBridgeEvent,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { and, eq, inArray, lt, lte, or } from "drizzle-orm";
import { executeQuery, executeTransaction } from "../../../lib/db/drizzle-client";
import {
  repositoryItemChunks,
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  settings,
  type RepositoryProcessingMetrics,
} from "../../../lib/db/schema";
import {
  PDF_PROCESSOR_VERSION,
  extractPdfText,
  segmentPdfPages,
} from "../../../lib/repositories/content-platform/pdf-processing";
import {
  MAX_INLINE_ARTIFACT_CHARACTERS,
  publishPdfVersion,
} from "../../../lib/repositories/content-platform/publication-service";
import {
  parseContentPlatformConfig,
  type ContentPlatformConfig,
} from "../../../lib/repositories/content-platform/config";
import {
  batchEmbeddingMessages,
  canonicalTextArtifactObjectKey,
  decideMalwareInspection,
  isRepositoryObjectKey,
  pagesFromTextract,
  parseContentProcessingMessage,
  type ContentProcessingMessage,
} from "./contract";

type JobMetrics = RepositoryProcessingMetrics;

const log = {
  info(message: string, metadata: Record<string, unknown> = {}) {
    process.stdout.write(`${JSON.stringify({ level: "INFO", message, ...metadata })}\n`);
  },
  error(message: string, metadata: Record<string, unknown> = {}) {
    process.stderr.write(`${JSON.stringify({ level: "ERROR", message, ...metadata })}\n`);
  },
};

const s3 = new S3Client({});
const sqs = new SQSClient({});
const textract = new TextractClient({});
const secrets = new SecretsManagerClient({});
const bucket = requiredEnvironment("DOCUMENTS_BUCKET_NAME");
const queueUrl = requiredEnvironment("CONTENT_PROCESSING_QUEUE_URL");
const embeddingQueueUrl = requiredEnvironment("EMBEDDING_QUEUE_URL");
const databaseSecretArn = requiredEnvironment("DATABASE_SECRET_ARN");
const databaseHost = requiredEnvironment("DATABASE_HOST");
// The lease outlives the 15-minute Lambda timeout. A timed-out invocation is
// recovered by the scheduled sweep without racing its final minute of work.
const LEASE_DURATION_MS = 16 * 60 * 1000;
const DEFER_SECONDS = 60;
const DISPATCH_BATCH_SIZE = 25;

let databaseReady: Promise<void> | null = null;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

async function ensureDatabaseCredentials(): Promise<void> {
  if (!databaseReady) {
    databaseReady = (async () => {
      const result = await secrets.send(
        new GetSecretValueCommand({ SecretId: databaseSecretArn })
      );
      if (!result.SecretString) throw new Error("Database secret has no SecretString");
      const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;
      if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
        throw new Error("Database secret is missing username or password");
      }
      process.env.DB_HOST = databaseHost;
      process.env.DB_PORT = process.env.DATABASE_PORT ?? "5432";
      process.env.DB_NAME = process.env.DATABASE_NAME ?? "aistudio";
      process.env.DB_USER = parsed.username;
      process.env.DB_PASSWORD = parsed.password;
      process.env.DB_SSL = "true";
      process.env.DB_MAX_CONNECTIONS = "2";
    })();
  }
  await databaseReady;
}

function parseMessage(record: SQSRecord): ContentProcessingMessage {
  return parseContentProcessingMessage(record.body);
}

async function getConfig(): Promise<ContentPlatformConfig> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(
          inArray(settings.key, [
            "CONTENT_PLATFORM_ENABLED",
            "CONTENT_DUAL_WRITE_ENABLED",
            "CONTENT_READ_V2_ENABLED",
            "NEXUS_ATTACHMENT_RETENTION_DAYS",
            "CONTENT_DELETION_GRACE_DAYS",
            "CONTENT_MAX_FILE_SIZE_GB",
            "CONTENT_MAX_PDF_SIZE_MB",
            "CONTENT_MAX_MEDIA_HOURS",
            "CONTENT_MALWARE_SCAN_REQUIRED",
            "CONTENT_OCR_STRATEGY",
            "CONTENT_VISUAL_INDEX_ENABLED",
            "GOOGLE_CONTENT_SYNC_ENABLED",
            "GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES",
          ])
        ),
    "contentProcessor.getConfig"
  );
  return parseContentPlatformConfig(
    Object.fromEntries(rows.map((row) => [row.key, row.value]))
  );
}

async function claimJob(message: ContentProcessingMessage, workerId: string) {
  return executeTransaction(
    async (tx) => {
      const [job] = await tx
        .select()
        .from(repositoryProcessingJobs)
        .where(eq(repositoryProcessingJobs.id, message.jobId))
        .limit(1)
        .for("update");
      if (!job || job.itemVersionId !== message.itemVersionId) {
        throw new Error("Processing job does not match its item version");
      }
      if (job.status === "succeeded" || job.status === "cancelled") return null;
      if (
        job.status === "running" &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt.getTime() > Date.now()
      ) {
        return null;
      }
      if (job.attempt >= job.maxAttempts) {
        await tx
          .update(repositoryItemVersions)
          .set({ processingStatus: "failed" })
          .where(eq(repositoryItemVersions.id, message.itemVersionId));
        throw new Error("Processing job exhausted its retry budget");
      }
      const now = new Date();
      const [claimed] = await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "running",
          attempt: job.attempt + 1,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
          startedAt: job.startedAt ?? now,
          finishedAt: null,
          updatedAt: now,
        })
        .where(eq(repositoryProcessingJobs.id, job.id))
        .returning();
      return claimed ?? null;
    },
    "contentProcessor.claimJob"
  );
}

async function deferJob(
  message: ContentProcessingMessage,
  metrics: JobMetrics,
  reason: string,
  claimedAttempt: number
): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          // Keep the durable outbox eligible for the scheduled sweep until the
          // delayed SQS send succeeds. Marking it queued first would strand the
          // job if SQS were unavailable between these two operations.
          status: "pending",
          // Waiting for an external policy/service is not a processing failure
          // and must not consume the finite retry budget.
          attempt: Math.max(0, claimedAttempt - 1),
          metrics,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: reason,
          availableAt: new Date(Date.now() + DEFER_SECONDS * 1000),
          updatedAt: new Date(),
        })
        .where(eq(repositoryProcessingJobs.id, message.jobId)),
    "contentProcessor.deferJob"
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      DelaySeconds: DEFER_SECONDS,
    })
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(repositoryProcessingJobs.id, message.jobId)),
    "contentProcessor.markDeferredJobDispatched"
  );
}

async function getMalwareStatus(objectKey: string): Promise<string | null> {
  const result = await s3.send(
    new GetObjectTaggingCommand({ Bucket: bucket, Key: objectKey })
  );
  return (
    result.TagSet?.find((tag) => tag.Key === "GuardDutyMalwareScanStatus")
      ?.Value ?? null
  );
}

async function blockVersion(
  message: ContentProcessingMessage,
  status: string
): Promise<void> {
  await executeTransaction(
    async (tx) => {
      await tx
        .update(repositoryItemVersions)
        .set({
          inspectionStatus: "blocked",
          inspectionDetails: { provider: "guardduty", status },
          storageStatus: "blocked",
          processingStatus: "failed",
        })
        .where(eq(repositoryItemVersions.id, message.itemVersionId));
      const [version] = await tx
        .select({ itemId: repositoryItemVersions.itemId })
        .from(repositoryItemVersions)
        .where(eq(repositoryItemVersions.id, message.itemVersionId))
        .limit(1);
      if (version) {
        await tx
          .update(repositoryItems)
          .set({
            lifecycleStatus: "unavailable",
            processingStatus: "failed",
            processingError: `Security inspection result: ${status}`,
            updatedAt: new Date(),
          })
          .where(eq(repositoryItems.id, version.itemId));
      }
      await tx
        .update(repositoryProcessingJobs)
        .set({
          status: "failed",
          lastErrorCode: "SECURITY_INSPECTION_BLOCKED",
          lastErrorMessage: status,
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(repositoryProcessingJobs.id, message.jobId));
    },
    "contentProcessor.blockVersion"
  );
}

async function downloadObject(objectKey: string): Promise<Uint8Array> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey })
  );
  if (!result.Body) throw new Error("S3 object has no body");
  return result.Body.transformToByteArray();
}

async function pollTextract(
  textractJobId: string
): Promise<{ status: "pending" } | { status: "complete"; blocks: Block[] }> {
  const blocks: Block[] = [];
  let nextToken: string | undefined;
  do {
    const result = await textract.send(
      new GetDocumentTextDetectionCommand({ JobId: textractJobId, NextToken: nextToken })
    );
    if (result.JobStatus === "IN_PROGRESS") return { status: "pending" };
    if (result.JobStatus !== "SUCCEEDED") {
      throw new Error(`Textract OCR failed with status ${result.JobStatus ?? "UNKNOWN"}`);
    }
    blocks.push(...(result.Blocks ?? []));
    nextToken = result.NextToken;
  } while (nextToken);
  return { status: "complete", blocks };
}

async function startTextract(objectKey: string): Promise<string> {
  const result = await textract.send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: { S3Object: { Bucket: bucket, Name: objectKey } },
      ClientRequestToken: objectKey.replace(/[^a-zA-Z0-9-_]/g, "-").slice(-64),
      JobTag: "aistudio-unified-content",
    })
  );
  if (!result.JobId) throw new Error("Textract did not return an OCR job id");
  return result.JobId;
}

async function queueEmbeddings(
  itemVersionId: string,
  generationId: string,
  itemId: number
): Promise<void> {
  const chunks = await executeQuery(
    (db) =>
      db
        .select({ id: repositoryItemChunks.id, content: repositoryItemChunks.content })
        .from(repositoryItemChunks)
        .where(
          and(
            eq(repositoryItemChunks.itemVersionId, itemVersionId),
            eq(repositoryItemChunks.indexGenerationId, generationId)
          )
        ),
    "contentProcessor.embeddingChunks"
  );
  const messages = batchEmbeddingMessages(itemId, generationId, chunks);
  for (const message of messages) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: embeddingQueueUrl,
        MessageBody: JSON.stringify(message),
      })
    );
  }
}

async function storeCanonicalText(
  repositoryId: number,
  itemVersionId: string,
  canonicalText: string
): Promise<{ canonicalText?: string; canonicalTextObjectKey?: string }> {
  if (canonicalText.length <= MAX_INLINE_ARTIFACT_CHARACTERS) {
    return { canonicalText };
  }
  const objectKey = canonicalTextArtifactObjectKey(
    repositoryId,
    itemVersionId,
    PDF_PROCESSOR_VERSION
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: canonicalText,
      ContentType: "text/markdown; charset=utf-8",
    })
  );
  return { canonicalTextObjectKey: objectKey };
}

async function processMessage(
  message: ContentProcessingMessage,
  workerId: string
): Promise<void> {
  const job = await claimJob(message, workerId);
  if (!job) return;
  const metrics = (job.metrics ?? {}) as JobMetrics;

  const [context] = await executeQuery(
    (db) =>
      db
        .select({
          itemId: repositoryItemVersions.itemId,
          objectKey: repositoryItemVersions.objectKey,
          declaredContentType: repositoryItemVersions.declaredContentType,
          byteSize: repositoryItemVersions.byteSize,
          repositoryId: repositoryItems.repositoryId,
        })
        .from(repositoryItemVersions)
        .innerJoin(repositoryItems, eq(repositoryItems.id, repositoryItemVersions.itemId))
        .where(eq(repositoryItemVersions.id, message.itemVersionId))
        .limit(1),
    "contentProcessor.getVersion"
  );
  if (!context?.objectKey) throw new Error("Item version has no S3 object key");
  if (!isRepositoryObjectKey(context.repositoryId, context.objectKey)) {
    throw new Error("Item version object key is outside its repository namespace");
  }
  if (context.declaredContentType !== "application/pdf") {
    throw new Error("Unified content PDF worker received an unsupported content type");
  }

  const config = await getConfig();
  if (!config.enabled) {
    await deferJob(message, metrics, "CONTENT_PLATFORM_DISABLED", job.attempt);
    return;
  }
  if (
    context.byteSize != null &&
    context.byteSize > config.maxPdfSizeMb * 1024 ** 2
  ) {
    throw new Error(
      `PDF exceeds the configured ${config.maxPdfSizeMb} MiB processing limit`
    );
  }
  let inspectionStatus: "clean" | "not_required" = "not_required";
  let inspectionDetails: Record<string, unknown> = { provider: "disabled" };
  const malwareStatus = config.malwareScanRequired
    ? await getMalwareStatus(context.objectKey)
    : null;
  const inspectionDecision = decideMalwareInspection(
    config.malwareScanRequired,
    malwareStatus
  );
  if (inspectionDecision.status === "awaiting") {
    await deferJob(message, metrics, "AWAITING_SECURITY_SCAN", job.attempt);
    return;
  }
  if (inspectionDecision.status === "blocked") {
    await blockVersion(message, inspectionDecision.providerStatus);
    return;
  }
  if (inspectionDecision.status === "clean") {
    inspectionStatus = "clean";
    inspectionDetails = {
      provider: "guardduty",
      status: inspectionDecision.providerStatus,
    };
  }

  const extracted = await extractPdfText(await downloadObject(context.objectKey));
  let pages = extracted.pages;
  if (extracted.needsOcrPages.length > 0) {
    if (config.ocrStrategy === "disabled") {
      throw new Error("PDF contains scanned pages but OCR is disabled");
    }
    if (!metrics.textractJobId) {
      metrics.textractJobId = await startTextract(context.objectKey);
      await deferJob(message, metrics, "AWAITING_OCR", job.attempt);
      return;
    }
    const ocr = await pollTextract(metrics.textractJobId);
    if (ocr.status === "pending") {
      await deferJob(message, metrics, "AWAITING_OCR", job.attempt);
      return;
    }
    const ocrPages = pagesFromTextract(ocr.blocks, extracted.pageCount);
    const needsOcr = new Set(extracted.needsOcrPages);
    pages = pages.map((page) =>
      needsOcr.has(page.page) ? ocrPages[page.page - 1] ?? page : page
    );
  }

  const segments = segmentPdfPages(pages);
  const canonicalText = pages
    .map((page) => `<!-- page:${page.page} -->\n${page.text}`)
    .join("\n\n");
  const canonicalArtifact = await storeCanonicalText(
    context.repositoryId,
    message.itemVersionId,
    canonicalText
  );
  const published = await publishPdfVersion({
    itemVersionId: message.itemVersionId,
    processorVersion: PDF_PROCESSOR_VERSION,
    inspectionStatus,
    inspectionDetails,
    malwareScanRequired: config.malwareScanRequired,
    ...canonicalArtifact,
    segments,
  });
  await queueEmbeddings(
    message.itemVersionId,
    published.generationId,
    context.itemId
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          status: "succeeded",
          metrics: { ...metrics, segments: segments.length },
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(repositoryProcessingJobs.id, message.jobId)),
    "contentProcessor.completeJob"
  );
}

async function markFailed(message: ContentProcessingMessage, error: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: "PROCESSING_ERROR",
          lastErrorMessage: errorMessage.slice(0, 4000),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(repositoryProcessingJobs.id, message.jobId)),
    "contentProcessor.failJob"
  );
}

async function dispatchPendingJobs(): Promise<void> {
  const now = new Date();
  const jobs = await executeQuery(
    (db) =>
      db
        .select({
          id: repositoryProcessingJobs.id,
          itemVersionId: repositoryProcessingJobs.itemVersionId,
        })
        .from(repositoryProcessingJobs)
        .where(
          and(
            or(
              eq(repositoryProcessingJobs.status, "pending"),
              eq(repositoryProcessingJobs.status, "failed"),
              and(
                eq(repositoryProcessingJobs.status, "running"),
                lte(repositoryProcessingJobs.leaseExpiresAt, now)
              )
            ),
            lte(repositoryProcessingJobs.availableAt, now),
            lt(repositoryProcessingJobs.attempt, repositoryProcessingJobs.maxAttempts)
          )
        )
        .limit(DISPATCH_BATCH_SIZE),
    "contentProcessor.pendingJobs"
  );
  for (const job of jobs) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ jobId: job.id, itemVersionId: job.itemVersionId }),
      })
    );
    await executeQuery(
      (db) =>
        db
          .update(repositoryProcessingJobs)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(repositoryProcessingJobs.id, job.id)),
      "contentProcessor.markDispatched"
    );
  }
  log.info("Dispatched pending unified content jobs", { count: jobs.length });
}

function isSqsEvent(event: SQSEvent | EventBridgeEvent<string, unknown>): event is SQSEvent {
  return "Records" in event;
}

export async function handler(
  event: SQSEvent | EventBridgeEvent<string, unknown>
): Promise<SQSBatchResponse | void> {
  await ensureDatabaseCredentials();
  if (!isSqsEvent(event)) {
    await dispatchPendingJobs();
    return;
  }

  const failures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    let message: ContentProcessingMessage | null = null;
    try {
      message = parseMessage(record);
      await processMessage(message, record.messageId);
    } catch (error) {
      log.error("Unified content record failed", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (message) await markFailed(message, error).catch(() => undefined);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
