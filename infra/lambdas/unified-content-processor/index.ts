import type { EventBridgeEvent, SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BedrockDataAutomationRuntimeClient,
  GetDataAutomationStatusCommand,
  InvokeDataAutomationAsyncCommand,
} from "@aws-sdk/client-bedrock-data-automation-runtime";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { executeQuery, executeTransaction } from "../../../lib/db/drizzle-client";
import {
  repositoryItemChunks,
  repositoryArtifacts,
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  settings,
  type RepositoryProcessingMetrics,
} from "../../../lib/db/schema";
import {
  buildImageSearchDocument,
  IMAGE_PROCESSOR_VERSION,
  imageArtifactObjectKey,
  isImageContentType,
  prepareRepositoryImage,
} from "../../../lib/repositories/content-platform/image-processing";
import {
  PDF_PROCESSOR_VERSION,
  extractPdfText,
  segmentPdfPages,
} from "../../../lib/repositories/content-platform/pdf-processing";
import {
  MEDIA_PROCESSOR_VERSION,
  maximumMediaBytes,
  mediaArtifactObjectPrefix,
  mediaKindForContentType,
  parseS3Uri,
  processBdaMediaOutput,
  type MediaKind,
  type ProcessedMediaOutput,
} from "../../../lib/repositories/content-platform/media-processing";
import {
  extractOfficeDocument,
  isOfficeContentType,
} from "../../../lib/repositories/content-platform/office-processing";
import {
  MAX_INLINE_ARTIFACT_CHARACTERS,
  publishDocumentVersion,
  type PublishableArtifact,
  type PublishableSegment,
} from "../../../lib/repositories/content-platform/publication-service";
import {
  parseContentPlatformConfig,
  type ContentPlatformConfig,
} from "../../../lib/repositories/content-platform/config";
import {
  batchEmbeddingMessages,
  canonicalTextArtifactObjectKey,
  decideMalwareInspection,
  imageLinesFromTextract,
  isRepositoryObjectKey,
  pagesFromTextract,
  parseContentProcessingMessage,
  type ContentProcessingMessage,
} from "./contract";
import { CONTENT_SWEEP_REDISPATCHABLE_STATUSES } from "../../../lib/repositories/content-platform/job-state";
import {
  repositoryEmbeddingConfigurationFromSettings,
  repositoryVisualEmbeddingConfiguration,
} from "../../../lib/repositories/embedding-configuration";

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
const bedrock = new BedrockRuntimeClient({});
const dataAutomation = new BedrockDataAutomationRuntimeClient({});
const secrets = new SecretsManagerClient({});
const bucket = requiredEnvironment("DOCUMENTS_BUCKET_NAME");
const queueUrl = requiredEnvironment("CONTENT_PROCESSING_QUEUE_URL");
const embeddingQueueUrl = requiredEnvironment("EMBEDDING_QUEUE_URL");
const dataAutomationProjectArn = requiredEnvironment("BDA_DATA_AUTOMATION_PROJECT_ARN");
const dataAutomationProfileArn = requiredEnvironment("BDA_DATA_AUTOMATION_PROFILE_ARN");
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
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: databaseSecretArn }));
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
            "CONTENT_MAX_OFFICE_SIZE_MB",
            "CONTENT_MAX_IMAGE_SIZE_MB",
            "CONTENT_MAX_MEDIA_HOURS",
            "CONTENT_MALWARE_SCAN_REQUIRED",
            "CONTENT_OCR_STRATEGY",
            "CONTENT_IMAGE_CAPTION_MODEL_ID",
            "CONTENT_VISUAL_INDEX_ENABLED",
            "CONTENT_VISUAL_EMBEDDING_MODEL_ID",
            "CONTENT_VISUAL_EMBEDDING_DIMENSIONS",
            "GOOGLE_CONTENT_SYNC_ENABLED",
            "GOOGLE_CONTENT_SYNC_INTERVAL_MINUTES",
          ]),
        ),
    "contentProcessor.getConfig",
  );
  return parseContentPlatformConfig(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

async function getEmbeddingConfiguration() {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(inArray(settings.key, ["EMBEDDING_MODEL_PROVIDER", "EMBEDDING_MODEL_ID", "EMBEDDING_DIMENSIONS"])),
    "contentProcessor.getEmbeddingConfiguration",
  );
  return repositoryEmbeddingConfigurationFromSettings(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

async function claimJob(message: ContentProcessingMessage, workerId: string) {
  return executeTransaction(async (tx) => {
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
    if (job.status === "running" && job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now()) {
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
  }, "contentProcessor.claimJob");
}

async function deferJob(
  message: ContentProcessingMessage,
  metrics: JobMetrics,
  reason: string,
  claimedAttempt: number,
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
    "contentProcessor.deferJob",
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      DelaySeconds: DEFER_SECONDS,
    }),
  );
  await executeQuery(
    (db) =>
      db
        .update(repositoryProcessingJobs)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(repositoryProcessingJobs.id, message.jobId)),
    "contentProcessor.markDeferredJobDispatched",
  );
}

async function getMalwareStatus(objectKey: string): Promise<string | null> {
  const result = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: objectKey }));
  return result.TagSet?.find((tag) => tag.Key === "GuardDutyMalwareScanStatus")?.Value ?? null;
}

async function blockVersion(message: ContentProcessingMessage, status: string): Promise<void> {
  await executeTransaction(async (tx) => {
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
  }, "contentProcessor.blockVersion");
}

async function downloadObject(objectKey: string): Promise<Uint8Array> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!result.Body) throw new Error("S3 object has no body");
  return result.Body.transformToByteArray();
}

async function downloadJsonObject(objectKey: string): Promise<unknown> {
  const bytes = await downloadObject(objectKey);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`BDA output object is not valid JSON: ${objectKey}`);
  }
}

async function startMediaAnalysis(input: {
  jobId: string;
  sourceObjectKey: string;
  outputPrefix: string;
}): Promise<string> {
  const result = await dataAutomation.send(
    new InvokeDataAutomationAsyncCommand({
      clientToken: input.jobId,
      inputConfiguration: {
        s3Uri: `s3://${bucket}/${input.sourceObjectKey}`,
      },
      outputConfiguration: {
        s3Uri: `s3://${bucket}/${input.outputPrefix}`,
      },
      dataAutomationConfiguration: {
        dataAutomationProjectArn,
        stage: "LIVE",
      },
      dataAutomationProfileArn,
      tags: [
        { key: "ManagedBy", value: "aistudio" },
        { key: "RepositoryProcessingJob", value: input.jobId },
      ],
    }),
  );
  if (!result.invocationArn) {
    throw new Error("Bedrock Data Automation did not return an invocation ARN");
  }
  return result.invocationArn;
}

async function resolveMediaAnalysisResult(input: {
  outputMetadataUri: string;
  expectedPrefix: string;
  modality: MediaKind;
}): Promise<{ objectKey: string; output: ProcessedMediaOutput }> {
  const outputMetadata = parseS3Uri(input.outputMetadataUri);
  if (outputMetadata.bucket !== bucket) {
    throw new Error("BDA output bucket does not match the repository bucket");
  }
  if (!outputMetadata.key.startsWith(input.expectedPrefix)) {
    throw new Error("BDA output is outside the item version artifact namespace");
  }

  const candidates = new Set<string>();
  if (outputMetadata.key.endsWith(".json")) candidates.add(outputMetadata.key);
  let continuationToken: string | undefined;
  let pages = 0;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: input.expectedPrefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1_000,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key?.includes("/standard_output/") && object.Key.endsWith("/result.json")) {
        candidates.add(object.Key);
      }
    }
    continuationToken = listed.NextContinuationToken;
    pages += 1;
    if (pages >= 10 && continuationToken) {
      throw new Error("BDA output contains too many objects to resolve safely");
    }
  } while (continuationToken);

  const orderedCandidates = [...candidates].sort((left, right) => {
    const leftStandard = left.includes("/standard_output/") ? 0 : 1;
    const rightStandard = right.includes("/standard_output/") ? 0 : 1;
    return leftStandard - rightStandard || left.localeCompare(right);
  });
  for (const objectKey of orderedCandidates.slice(0, 20)) {
    const value = await downloadJsonObject(objectKey);
    try {
      return {
        objectKey,
        output: processBdaMediaOutput(value, input.modality),
      };
    } catch {
      // job_metadata.json and unrelated standard outputs are expected in the
      // same namespace. Only a matching AUDIO or VIDEO result is publishable.
    }
  }
  throw new Error("BDA completed without a matching media standard output");
}

async function pollMediaAnalysis(input: {
  invocationArn: string;
  outputPrefix: string;
  modality: MediaKind;
}): Promise<{ status: "pending" } | { status: "complete"; objectKey: string; output: ProcessedMediaOutput }> {
  const result = await dataAutomation.send(new GetDataAutomationStatusCommand({ invocationArn: input.invocationArn }));
  if (result.status === "Created" || result.status === "InProgress") {
    return { status: "pending" };
  }
  if (result.status !== "Success") {
    const detail = [result.errorType, result.errorMessage].filter(Boolean).join(": ");
    throw new Error(
      `Bedrock Data Automation failed with status ${result.status ?? "UNKNOWN"}` + `${detail ? ` (${detail})` : ""}`,
    );
  }
  if (!result.outputConfiguration?.s3Uri) {
    throw new Error("BDA completed without an output metadata URI");
  }
  const resolved = await resolveMediaAnalysisResult({
    outputMetadataUri: result.outputConfiguration.s3Uri,
    expectedPrefix: input.outputPrefix,
    modality: input.modality,
  });
  return { status: "complete", ...resolved };
}

async function pollTextract(
  textractJobId: string,
): Promise<{ status: "pending" } | { status: "complete"; blocks: Block[] }> {
  const blocks: Block[] = [];
  let nextToken: string | undefined;
  do {
    const result = await textract.send(
      new GetDocumentTextDetectionCommand({
        JobId: textractJobId,
        NextToken: nextToken,
      }),
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
    }),
  );
  if (!result.JobId) throw new Error("Textract did not return an OCR job id");
  return result.JobId;
}

async function storeImageDerivative(objectKey: string, body: Uint8Array): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: "image/jpeg",
      CacheControl: "private, max-age=31536000, immutable",
    }),
  );
}

async function storeTextDerivative(objectKey: string, body: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: "text/plain; charset=utf-8",
      CacheControl: "private, max-age=31536000, immutable",
    }),
  );
}

async function captionImage(
  image: Uint8Array,
  modelId: string,
): Promise<{
  caption: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  stopReason?: string;
}> {
  const result = await bedrock.send(
    new ConverseCommand({
      modelId,
      system: [
        {
          text:
            "Create concise, factual image descriptions for enterprise search. " +
            "Describe the visible subject, setting, diagram relationships, and important labels. " +
            "Do not speculate about identity, intent, or facts that are not visible. Return plain text only.",
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { image: { format: "jpeg", source: { bytes: image } } },
            {
              text:
                "Describe this image for search and accessibility in no more than 120 words. " +
                "Textract handles verbatim OCR separately, so focus on visual meaning and structure.",
            },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 300, temperature: 0.1, topP: 0.9 },
    }),
  );
  const caption = (result.output?.message?.content ?? [])
    .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
    .join("\n")
    .trim();
  if (!caption) throw new Error("Image caption model returned no text");
  return {
    caption,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    latencyMs: result.metrics?.latencyMs,
    stopReason: result.stopReason,
  };
}

async function queueEmbeddings(
  generationId: string,
  itemId: number,
  visualEnabled: boolean,
): Promise<void> {
  let lastChunkId = 0;
  for (;;) {
    const chunks = await executeQuery(
      (db) =>
        db
          .select({
            id: repositoryItemChunks.id,
            content: repositoryItemChunks.content,
            contextPrefix: repositoryItemChunks.contextPrefix,
            modality: repositoryItemChunks.modality,
            visualObjectKey: sql<string | null>`(
              SELECT visual_artifact.object_key
              FROM ${repositoryArtifacts} visual_artifact
              WHERE visual_artifact.item_version_id = ${repositoryItemChunks.itemVersionId}
                AND visual_artifact.kind = 'thumbnail'
              ORDER BY visual_artifact.created_at DESC
              LIMIT 1
            )`,
            visualMediaType: sql<"image/jpeg" | null>`(
              SELECT visual_artifact.media_type
              FROM ${repositoryArtifacts} visual_artifact
              WHERE visual_artifact.item_version_id = ${repositoryItemChunks.itemVersionId}
                AND visual_artifact.kind = 'thumbnail'
              ORDER BY visual_artifact.created_at DESC
              LIMIT 1
            )`,
          })
          .from(repositoryItemChunks)
          .where(
            and(
              eq(repositoryItemChunks.indexGenerationId, generationId),
              visualEnabled
                ? or(
                    isNull(repositoryItemChunks.embedding),
                    and(
                      inArray(repositoryItemChunks.modality, ["image", "video"]),
                      isNull(repositoryItemChunks.visualEmbedding),
                    ),
                  )
                : isNull(repositoryItemChunks.embedding),
              gt(repositoryItemChunks.id, lastChunkId),
            ),
          )
          .orderBy(asc(repositoryItemChunks.id))
          .limit(500),
      "contentProcessor.embeddingChunks",
    );
    if (chunks.length === 0) break;
    for (const message of batchEmbeddingMessages(itemId, generationId, chunks)) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: embeddingQueueUrl,
          MessageBody: JSON.stringify(message),
        }),
      );
    }
    const lastChunk = chunks.at(-1);
    if (!lastChunk) break;
    lastChunkId = lastChunk.id;
  }
}

async function storeCanonicalText(
  repositoryId: number,
  itemVersionId: string,
  canonicalText: string,
  processorVersion: string,
): Promise<{ canonicalText?: string; canonicalTextObjectKey?: string }> {
  if (canonicalText.length <= MAX_INLINE_ARTIFACT_CHARACTERS) {
    return { canonicalText };
  }
  const objectKey = canonicalTextArtifactObjectKey(repositoryId, itemVersionId, processorVersion);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: canonicalText,
      ContentType: "text/markdown; charset=utf-8",
    }),
  );
  return { canonicalTextObjectKey: objectKey };
}

async function processMessage(message: ContentProcessingMessage, workerId: string): Promise<void> {
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
    "contentProcessor.getVersion",
  );
  if (!context?.objectKey) throw new Error("Item version has no S3 object key");
  if (!isRepositoryObjectKey(context.repositoryId, context.objectKey)) {
    throw new Error("Item version object key is outside its repository namespace");
  }
  const declaredContentType = context.declaredContentType;
  if (!declaredContentType) {
    throw new Error("Item version has no declared content type");
  }
  const isPdf = declaredContentType === "application/pdf";
  const isImage = isImageContentType(declaredContentType);
  const mediaKind = mediaKindForContentType(declaredContentType);
  if (!isPdf && !isImage && !mediaKind && !isOfficeContentType(declaredContentType)) {
    throw new Error("Unified content worker received an unsupported content type");
  }

  const config = await getConfig();
  if (!config.enabled) {
    await deferJob(message, metrics, "CONTENT_PLATFORM_DISABLED", job.attempt);
    return;
  }
  const processingLimitBytes = mediaKind
    ? Math.min(maximumMediaBytes(mediaKind), config.maxFileSizeGb * 1024 ** 3)
    : (isPdf ? config.maxPdfSizeMb : isImage ? config.maxImageSizeMb : config.maxOfficeSizeMb) * 1024 ** 2;
  if (context.byteSize != null && context.byteSize > processingLimitBytes) {
    throw new Error(`File exceeds the configured ${Math.floor(processingLimitBytes / 1024 ** 2)} MiB processing limit`);
  }
  let inspectionStatus: "clean" | "not_required" = "not_required";
  let inspectionDetails: Record<string, unknown> = { provider: "disabled" };
  const malwareStatus = config.malwareScanRequired ? await getMalwareStatus(context.objectKey) : null;
  const inspectionDecision = decideMalwareInspection(config.malwareScanRequired, malwareStatus);
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

  let segments: PublishableSegment[];
  let canonicalText: string;
  let processorVersion: string;
  let processorName: string;
  let detectedContentType = declaredContentType;
  let artifactMetadata: Record<string, unknown>;
  let additionalArtifacts: PublishableArtifact[] | undefined;
  if (mediaKind) {
    const outputPrefix = mediaArtifactObjectPrefix(context.repositoryId, message.itemVersionId);
    if (metrics.bdaOutputPrefix && metrics.bdaOutputPrefix !== outputPrefix) {
      throw new Error("BDA invocation does not match the item version namespace");
    }
    metrics.bdaOutputPrefix = outputPrefix;
    if (!metrics.bdaInvocationArn) {
      metrics.bdaInvocationArn = await startMediaAnalysis({
        jobId: message.jobId,
        sourceObjectKey: context.objectKey,
        outputPrefix,
      });
      await deferJob(message, metrics, "AWAITING_MEDIA_ANALYSIS", job.attempt);
      return;
    }
    const analysis = await pollMediaAnalysis({
      invocationArn: metrics.bdaInvocationArn,
      outputPrefix,
      modality: mediaKind,
    });
    if (analysis.status === "pending") {
      await deferJob(message, metrics, "AWAITING_MEDIA_ANALYSIS", job.attempt);
      return;
    }
    const maximumDurationMs = config.maxMediaHours * 60 * 60 * 1_000;
    if (analysis.output.metadata.durationMs > maximumDurationMs) {
      throw new Error(`Media duration exceeds the configured ${config.maxMediaHours} hour limit`);
    }

    const transcriptObjectKey = `${outputPrefix}transcript.txt`;
    const largeTranscript = analysis.output.transcriptText.length > MAX_INLINE_ARTIFACT_CHARACTERS;
    if (largeTranscript) {
      await storeTextDerivative(transcriptObjectKey, analysis.output.transcriptText);
    }

    metrics.provider = "amazon-bedrock-data-automation";
    metrics.bdaResultObjectKey = analysis.objectKey;
    metrics.mediaDurationMs = analysis.output.metadata.durationMs;
    metrics.mediaFormat = analysis.output.metadata.format;
    metrics.mediaCodec = analysis.output.metadata.codec;
    metrics.mediaChannels = analysis.output.metadata.channels;
    metrics.frameRate = analysis.output.metadata.frameRate;
    metrics.frameWidth = analysis.output.metadata.frameWidth;
    metrics.frameHeight = analysis.output.metadata.frameHeight;
    metrics.wordCount = analysis.output.metadata.wordCount;
    metrics.topicCount = analysis.output.metadata.topicCount;
    metrics.shotCount = analysis.output.metadata.shotCount;
    metrics.chapterCount = analysis.output.metadata.chapterCount;
    metrics.speakerCount = analysis.output.metadata.speakerCount;
    segments = analysis.output.segments;
    canonicalText = analysis.output.canonicalText;
    processorVersion = MEDIA_PROCESSOR_VERSION;
    processorName = "aistudio-media";
    artifactMetadata = {
      provider: "amazon-bedrock-data-automation",
      projectArn: dataAutomationProjectArn,
      ...analysis.output.metadata,
    };
    additionalArtifacts = [
      {
        kind: mediaKind,
        mediaType: declaredContentType,
        objectKey: context.objectKey,
        timeStartMs: 0,
        timeEndMs: analysis.output.metadata.durationMs,
        metadata: { role: "source" },
      },
      {
        kind: "layout",
        mediaType: "application/json",
        objectKey: analysis.objectKey,
        timeStartMs: 0,
        timeEndMs: analysis.output.metadata.durationMs,
        metadata: {
          provider: "amazon-bedrock-data-automation",
          projectArn: dataAutomationProjectArn,
        },
      },
      ...(analysis.output.transcriptText
        ? [
            {
              kind: "transcript" as const,
              mediaType: "text/plain",
              textInline: largeTranscript ? undefined : analysis.output.transcriptText,
              objectKey: largeTranscript ? transcriptObjectKey : undefined,
              timeStartMs: 0,
              timeEndMs: analysis.output.metadata.durationMs,
              metadata: {
                provider: "amazon-bedrock-data-automation",
                speakerCount: analysis.output.metadata.speakerCount,
                wordCount: analysis.output.metadata.wordCount,
              },
            },
          ]
        : []),
      ...(analysis.output.summary
        ? [
            {
              kind: "caption" as const,
              mediaType: "text/plain",
              textInline: analysis.output.summary,
              timeStartMs: 0,
              timeEndMs: analysis.output.metadata.durationMs,
              metadata: {
                provider: "amazon-bedrock-data-automation",
                role: "media-summary",
              },
            },
          ]
        : []),
    ];
  } else {
    const source = await downloadObject(context.objectKey);
    if (isPdf) {
      const extracted = await extractPdfText(source);
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
        pages = pages.map((page) => (needsOcr.has(page.page) ? (ocrPages[page.page - 1] ?? page) : page));
      }
      segments = segmentPdfPages(pages);
      canonicalText = pages.map((page) => `<!-- page:${page.page} -->\n${page.text}`).join("\n\n");
      processorVersion = PDF_PROCESSOR_VERSION;
      processorName = "aistudio-pdf";
      artifactMetadata = { pageCount: pages.length };
    } else if (isOfficeContentType(declaredContentType)) {
      const extracted = await extractOfficeDocument(source, declaredContentType);
      segments = extracted.segments;
      canonicalText = extracted.canonicalText;
      processorVersion = extracted.processorVersion;
      processorName = "aistudio-office";
      artifactMetadata = extracted.metadata;
    } else {
      const prepared = await prepareRepositoryImage(source, declaredContentType);
      const thumbnailObjectKey = imageArtifactObjectKey(context.repositoryId, message.itemVersionId, "thumbnail.jpg");
      const ocrSourceObjectKey = imageArtifactObjectKey(context.repositoryId, message.itemVersionId, "ocr-source.jpg");
      await Promise.all([
        storeImageDerivative(thumbnailObjectKey, prepared.thumbnail),
        storeImageDerivative(ocrSourceObjectKey, prepared.ocrImage),
      ]);

      let ocrBlocks: Block[] = [];
      if (config.ocrStrategy !== "disabled") {
        if (!metrics.textractJobId) {
          metrics.textractObjectKey = ocrSourceObjectKey;
          metrics.textractJobId = await startTextract(ocrSourceObjectKey);
          await deferJob(message, metrics, "AWAITING_OCR", job.attempt);
          return;
        }
        if (metrics.textractObjectKey && metrics.textractObjectKey !== ocrSourceObjectKey) {
          throw new Error("Textract job does not match the normalized image artifact");
        }
        const ocr = await pollTextract(metrics.textractJobId);
        if (ocr.status === "pending") {
          await deferJob(message, metrics, "AWAITING_OCR", job.attempt);
          return;
        }
        ocrBlocks = ocr.blocks;
      }

      const ocrLines = imageLinesFromTextract(ocrBlocks);
      const caption = await captionImage(prepared.captionImage, config.imageCaptionModelId);
      const searchable = buildImageSearchDocument({
        caption: caption.caption,
        ocrLines,
        width: prepared.width,
        height: prepared.height,
        detectedContentType: prepared.detectedContentType,
      });
      const ocrArtifactObjectKey = imageArtifactObjectKey(context.repositoryId, message.itemVersionId, "ocr.txt");
      const largeOcrText = searchable.ocrText.length > MAX_INLINE_ARTIFACT_CHARACTERS;
      if (largeOcrText) {
        await storeTextDerivative(ocrArtifactObjectKey, searchable.ocrText);
      }

      metrics.provider = "amazon-bedrock";
      metrics.modelId = config.imageCaptionModelId;
      metrics.inputTokens = caption.inputTokens;
      metrics.outputTokens = caption.outputTokens;
      metrics.captionLatencyMs = caption.latencyMs;
      metrics.imageWidth = prepared.width;
      metrics.imageHeight = prepared.height;
      metrics.thumbnailBytes = prepared.thumbnail.byteLength;
      metrics.ocrLines = ocrLines.length;
      segments = searchable.segments;
      canonicalText = searchable.canonicalText;
      processorVersion = IMAGE_PROCESSOR_VERSION;
      processorName = "aistudio-image";
      detectedContentType = prepared.detectedContentType;
      artifactMetadata = {
        ...prepared.metadata,
        captionModelId: config.imageCaptionModelId,
        captionStopReason: caption.stopReason,
        ocrStrategy: config.ocrStrategy,
        ocrLineCount: ocrLines.length,
        visualIndexEligible: true,
        visualIndexEnabled: config.visualIndexEnabled,
      };
      additionalArtifacts = [
        {
          kind: "image",
          mediaType: prepared.detectedContentType,
          objectKey: context.objectKey,
          sha256: prepared.sourceSha256,
          metadata: prepared.metadata,
        },
        {
          kind: "thumbnail",
          mediaType: "image/jpeg",
          objectKey: thumbnailObjectKey,
          sha256: prepared.thumbnailSha256,
          metadata: {
            sourceWidth: prepared.width,
            sourceHeight: prepared.height,
          },
        },
        {
          kind: "caption",
          mediaType: "text/plain",
          textInline: caption.caption,
          sourceRegions: [{ x: 0, y: 0, width: 1, height: 1 }],
          metadata: {
            provider: "amazon-bedrock",
            modelId: config.imageCaptionModelId,
            stopReason: caption.stopReason,
          },
        },
        ...(searchable.ocrText
          ? [
              {
                kind: "layout" as const,
                mediaType: "text/plain",
                textInline: largeOcrText ? undefined : searchable.ocrText,
                objectKey: largeOcrText ? ocrArtifactObjectKey : undefined,
                sourceRegions: searchable.ocrRegions.slice(0, 1_000),
                metadata: {
                  provider: "amazon-textract",
                  lineCount: ocrLines.length,
                  regionCount: searchable.ocrRegions.length,
                },
              },
            ]
          : []),
      ];
    }
  }
  const canonicalArtifact = await storeCanonicalText(
    context.repositoryId,
    message.itemVersionId,
    canonicalText,
    processorVersion,
  );
  const embeddingConfiguration = await getEmbeddingConfiguration();
  const visualEmbeddingConfiguration = repositoryVisualEmbeddingConfiguration(
    config.visualIndexEnabled,
    config.visualEmbeddingModelId,
    config.visualEmbeddingDimensions,
  );
  const published = await publishDocumentVersion({
    itemVersionId: message.itemVersionId,
    processorVersion,
    processorName,
    detectedContentType,
    inspectionStatus,
    inspectionDetails,
    malwareScanRequired: config.malwareScanRequired,
    artifactMetadata,
    additionalArtifacts,
    embeddingModel: embeddingConfiguration.descriptor,
    embeddingDimensions: embeddingConfiguration.dimensions,
    visualEmbeddingModel: visualEmbeddingConfiguration?.descriptor,
    visualEmbeddingDimensions: visualEmbeddingConfiguration?.dimensions,
    segmentationVersion: "retrieval-v2",
    ...canonicalArtifact,
    segments,
  });
  await queueEmbeddings(
    published.generationId,
    context.itemId,
    visualEmbeddingConfiguration !== null,
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
    "contentProcessor.completeJob",
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
    "contentProcessor.failJob",
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
              inArray(repositoryProcessingJobs.status, [...CONTENT_SWEEP_REDISPATCHABLE_STATUSES]),
              and(eq(repositoryProcessingJobs.status, "running"), lte(repositoryProcessingJobs.leaseExpiresAt, now)),
            ),
            lte(repositoryProcessingJobs.availableAt, now),
            lt(repositoryProcessingJobs.attempt, repositoryProcessingJobs.maxAttempts),
          ),
        )
        .limit(DISPATCH_BATCH_SIZE),
    "contentProcessor.pendingJobs",
  );
  for (const job of jobs) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          jobId: job.id,
          itemVersionId: job.itemVersionId,
        }),
      }),
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
      "contentProcessor.markDispatched",
    );
  }
  log.info("Dispatched pending unified content jobs", { count: jobs.length });
}

function isSqsEvent(event: SQSEvent | EventBridgeEvent<string, unknown>): event is SQSEvent {
  return "Records" in event;
}

export async function handler(event: SQSEvent | EventBridgeEvent<string, unknown>): Promise<SQSBatchResponse | void> {
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
