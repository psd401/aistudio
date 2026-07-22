import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  repositoryItems,
  repositoryItemVersions,
  repositoryProcessingJobs,
  repositoryUploadSessions,
} from "@/lib/db/schema";
import { sanitizeFileName } from "@/lib/aws/document-upload";
import { Settings } from "@/lib/settings-manager";
import type { ContentPlatformConfig } from "./config";
import {
  buildProcessingIdempotencyKey,
  CONTENT_PROCESSING_MAX_ATTEMPTS,
  CONTENT_PROCESSOR_CONTRACT_VERSION,
} from "./job-state";
import { sourceRevisionForObjectKey } from "./ingestion-service";
import { isImageContentType } from "./image-processing";
import {
  maximumMediaBytes,
  mediaKindForContentType,
} from "./media-processing";
import { isOfficeContentType } from "./office-processing";
import { isCanonicalTextContentType } from "./text-processing";
import { buildRepositorySourceObjectKey } from "./object-key";

export interface InitiateRepositoryUploadInput {
  repositoryId: number;
  userId: number;
  itemName: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}

export interface UploadPartUrl {
  partNumber: number;
  uploadUrl: string;
}

export interface InitiatedRepositoryUpload {
  sessionId: string;
  objectKey: string;
  uploadMethod: "single" | "multipart";
  uploadUrl?: string;
  partSize?: number;
  partUrls?: UploadPartUrl[];
  expiresAt: string;
}

export interface CompleteRepositoryUploadInput {
  repositoryId: number;
  userId: number;
  sessionId: string;
  parts?: Array<{ ETag: string; PartNumber: number }>;
}

export interface CompletedRepositoryUpload {
  itemId: number;
  itemVersionId: string;
  processingJobId: string;
  replayed: boolean;
}

interface StoredObjectMetadata {
  byteSize: number;
  contentType?: string;
}

export interface RepositoryUploadStorage {
  createSingleUpload(input: {
    objectKey: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<{ uploadUrl: string }>;
  createMultipartUpload(input: {
    objectKey: string;
    contentType: string;
    partCount: number;
    metadata: Record<string, string>;
  }): Promise<{ uploadId: string; partUrls: UploadPartUrl[] }>;
  completeMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
    parts: Array<{ ETag: string; PartNumber: number }>;
  }): Promise<void>;
  abortMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
  }): Promise<void>;
  headObject(objectKey: string): Promise<StoredObjectMetadata>;
}

const SINGLE_UPLOAD_LIMIT = 10 * 1024 * 1024;
const MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024;
// Keep initiation responses bounded. S3 permits 10,000 parts, but returning
// thousands of signed URLs creates oversized API responses and browser state.
const MAX_MULTIPART_PARTS = 100;
const UPLOAD_EXPIRY_SECONDS = 60 * 60;

export function isCanonicalUploadContentType(contentType: string): boolean {
  return (
    contentType === "application/pdf" ||
    isOfficeContentType(contentType) ||
    isCanonicalTextContentType(contentType) ||
    isImageContentType(contentType) ||
    mediaKindForContentType(contentType) !== null
  );
}

/** Backwards-compatible name for callers compiled before image ingestion. */
export const isCanonicalDocumentContentType = isCanonicalUploadContentType;

function partLayout(byteSize: number): { partSize: number; partCount: number } {
  const partSize = Math.max(
    MIN_MULTIPART_PART_SIZE,
    Math.ceil(byteSize / MAX_MULTIPART_PARTS)
  );
  return { partSize, partCount: Math.ceil(byteSize / partSize) };
}

function validateInitiation(
  input: InitiateRepositoryUploadInput,
  config: ContentPlatformConfig
): void {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) {
    throw new Error("A valid repository id is required");
  }
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new Error("A valid user id is required");
  }
  if (!input.itemName.trim() || input.itemName.length > 500) {
    throw new Error("A repository item name is required");
  }
  if (!input.fileName.trim() || input.fileName.length > 500) {
    throw new Error("A valid file name is required");
  }
  if (!isCanonicalUploadContentType(input.contentType)) {
    throw new Error(
      "The canonical processor accepts PDF, Office, text, image, audio, and video files only"
    );
  }
  const mediaKind = mediaKindForContentType(input.contentType);
  const processorLimitBytes = mediaKind
    ? maximumMediaBytes(mediaKind)
    : (
    input.contentType === "application/pdf"
      ? config.maxPdfSizeMb
      : isImageContentType(input.contentType)
        ? config.maxImageSizeMb
        : config.maxOfficeSizeMb
      ) * 1024 ** 2;
  const maximumBytes = Math.min(
    config.maxFileSizeGb * 1024 ** 3,
    processorLimitBytes
  );
  if (
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize <= 0 ||
    input.byteSize > maximumBytes
  ) {
    throw new Error(
      `File size must not exceed ${Math.floor(maximumBytes / 1024 ** 2)} MiB for this processor`
    );
  }
}

export async function resolveRepositoryUploadStorageConfig(): Promise<{
  bucket: string;
  region: string | undefined;
}> {
  const config = await Settings.getS3();
  const bucket = config.bucket?.trim();
  if (!bucket) throw new Error("S3_BUCKET is not configured");
  return { bucket, region: config.region ?? undefined };
}

async function createS3UploadStorage(): Promise<RepositoryUploadStorage> {
  const { bucket, region } = await resolveRepositoryUploadStorageConfig();
  const client = new S3Client({ region });
  return {
    async createSingleUpload(input) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
        Metadata: input.metadata,
      });
      return {
        uploadUrl: await getSignedUrl(client, command, {
          expiresIn: UPLOAD_EXPIRY_SECONDS,
        }),
      };
    },
    async createMultipartUpload(input) {
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: input.objectKey,
          ContentType: input.contentType,
          Metadata: input.metadata,
        })
      );
      if (!created.UploadId) throw new Error("S3 did not return a multipart upload id");
      const partUrls = await Promise.all(
        Array.from({ length: input.partCount }, async (_, index) => {
          const partNumber = index + 1;
          return {
            partNumber,
            uploadUrl: await getSignedUrl(
              client,
              new UploadPartCommand({
                Bucket: bucket,
                Key: input.objectKey,
                UploadId: created.UploadId,
                PartNumber: partNumber,
              }),
              { expiresIn: UPLOAD_EXPIRY_SECONDS }
            ),
          };
        })
      );
      return { uploadId: created.UploadId, partUrls };
    },
    async completeMultipartUpload(input) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts
              .slice()
              .sort((a, b) => a.PartNumber - b.PartNumber)
              .map((part) => ({
                ETag: part.ETag.replaceAll('"', ""),
                PartNumber: part.PartNumber,
              })),
          },
        })
      );
    },
    async abortMultipartUpload(input) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
        })
      );
    },
    async headObject(objectKey) {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: objectKey })
      );
      if (result.ContentLength == null) {
        throw new Error("Uploaded object did not report a content length");
      }
      return { byteSize: result.ContentLength, contentType: result.ContentType };
    },
  };
}

export async function initiateRepositoryUpload(
  input: InitiateRepositoryUploadInput,
  config: ContentPlatformConfig,
  storage?: RepositoryUploadStorage
): Promise<InitiatedRepositoryUpload> {
  validateInitiation(input, config);
  const resolvedStorage = storage ?? (await createS3UploadStorage());
  const sessionId = randomUUID();
  const safeFileName = sanitizeFileName(input.fileName);
  const objectKey = buildRepositorySourceObjectKey(
    input.repositoryId,
    safeFileName,
    sessionId
  );
  const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000);
  const metadata = {
    repositoryId: String(input.repositoryId),
    uploadSessionId: sessionId,
  };

  let uploadId: string | undefined;
  try {
    if (input.byteSize <= SINGLE_UPLOAD_LIMIT) {
      const created = await resolvedStorage.createSingleUpload({
        objectKey,
        contentType: input.contentType,
        metadata,
      });
      await executeQuery(
        (db) =>
          db.insert(repositoryUploadSessions).values({
            id: sessionId,
            repositoryId: input.repositoryId,
            createdBy: input.userId,
            objectKey,
            uploadMethod: "single",
            itemName: input.itemName.trim(),
            originalFileName: input.fileName,
            declaredContentType: input.contentType,
            expectedByteSize: input.byteSize,
            status: "uploading",
            expiresAt,
          }),
        "contentPlatform.initiateSingleUpload"
      );
      return {
        sessionId,
        objectKey,
        uploadMethod: "single",
        uploadUrl: created.uploadUrl,
        expiresAt: expiresAt.toISOString(),
      };
    }

    const layout = partLayout(input.byteSize);
    const created = await resolvedStorage.createMultipartUpload({
      objectKey,
      contentType: input.contentType,
      partCount: layout.partCount,
      metadata,
    });
    uploadId = created.uploadId;
    await executeQuery(
      (db) =>
        db.insert(repositoryUploadSessions).values({
          id: sessionId,
          repositoryId: input.repositoryId,
          createdBy: input.userId,
          objectKey,
          multipartUploadId: created.uploadId,
          uploadMethod: "multipart",
          partSize: layout.partSize,
          partCount: layout.partCount,
          itemName: input.itemName.trim(),
          originalFileName: input.fileName,
          declaredContentType: input.contentType,
          expectedByteSize: input.byteSize,
          status: "uploading",
          expiresAt,
        }),
      "contentPlatform.initiateMultipartUpload"
    );
    return {
      sessionId,
      objectKey,
      uploadMethod: "multipart",
      partSize: layout.partSize,
      partUrls: created.partUrls,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    if (uploadId) {
      await resolvedStorage
        .abortMultipartUpload({ objectKey, uploadId })
        .catch(() => undefined);
    }
    throw error;
  }
}

function validateParts(
  parts: Array<{ ETag: string; PartNumber: number }> | undefined,
  expectedCount: number
): Array<{ ETag: string; PartNumber: number }> {
  if (!parts || parts.length !== expectedCount) {
    throw new Error(`Multipart completion requires exactly ${expectedCount} parts`);
  }
  const numbers = new Set(parts.map((part) => part.PartNumber));
  if (
    numbers.size !== expectedCount ||
    parts.some(
      (part) =>
        !part.ETag.trim() ||
        !Number.isSafeInteger(part.PartNumber) ||
        part.PartNumber < 1 ||
        part.PartNumber > expectedCount
    )
  ) {
    throw new Error("Multipart parts are invalid or duplicated");
  }
  return parts;
}

function getRepositoryUploadSession(input: CompleteRepositoryUploadInput) {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryUploadSessions)
        .where(
          and(
            eq(repositoryUploadSessions.id, input.sessionId),
            eq(repositoryUploadSessions.repositoryId, input.repositoryId),
            eq(repositoryUploadSessions.createdBy, input.userId)
          )
        )
        .limit(1),
    "contentPlatform.getUploadSession"
  );
}

export async function completeRepositoryUpload(
  input: CompleteRepositoryUploadInput,
  storage?: RepositoryUploadStorage
): Promise<CompletedRepositoryUpload> {
  const resolvedStorage = storage ?? (await createS3UploadStorage());
  const [session] = await getRepositoryUploadSession(input);
  if (!session) throw new Error("Upload session was not found");
  if (session.expiresAt.getTime() <= Date.now()) throw new Error("Upload session expired");
  if (session.status === "aborted" || session.status === "expired") {
    throw new Error("Upload session is no longer active");
  }

  if (session.uploadMethod === "multipart" && session.status !== "completed") {
    if (!session.multipartUploadId || !session.partCount) {
      throw new Error("Multipart upload session is incomplete");
    }
    try {
      await resolvedStorage.completeMultipartUpload({
        objectKey: session.objectKey,
        uploadId: session.multipartUploadId,
        parts: validateParts(input.parts, session.partCount),
      });
    } catch (completionError) {
      // S3 completion can succeed even when its response is lost. A successful
      // HEAD below proves the object exists and makes completion safely
      // retryable; otherwise preserve the original, more useful S3 error.
      await resolvedStorage.headObject(session.objectKey).catch(() => {
        throw completionError;
      });
    }
  }

  const object = await resolvedStorage.headObject(session.objectKey);
  if (object.byteSize !== session.expectedByteSize) {
    throw new Error("Uploaded object size does not match the initiated upload");
  }
  if (object.contentType && object.contentType !== session.declaredContentType) {
    throw new Error("Uploaded object type does not match the initiated upload");
  }

  return executeTransaction(
    async (tx) => {
      const [locked] = await tx
        .select()
        .from(repositoryUploadSessions)
        .where(eq(repositoryUploadSessions.id, session.id))
        .limit(1)
        .for("update");
      if (!locked) throw new Error("Upload session was not found");

      if (locked.status === "completed" && locked.itemVersionId) {
        const [existing] = await tx
          .select({
            itemId: repositoryItemVersions.itemId,
            jobId: repositoryProcessingJobs.id,
          })
          .from(repositoryItemVersions)
          .innerJoin(
            repositoryProcessingJobs,
            eq(repositoryProcessingJobs.itemVersionId, repositoryItemVersions.id)
          )
          .where(eq(repositoryItemVersions.id, locked.itemVersionId))
          .limit(1);
        if (!existing) throw new Error("Completed upload registration is inconsistent");
        return {
          itemId: existing.itemId,
          itemVersionId: locked.itemVersionId,
          processingJobId: existing.jobId,
          replayed: true,
        };
      }

      const now = new Date();
      const mediaKind = mediaKindForContentType(locked.declaredContentType);
      const [item] = await tx
        .insert(repositoryItems)
        .values({
          repositoryId: locked.repositoryId,
          type:
            mediaKind ??
            (isImageContentType(locked.declaredContentType)
              ? "image"
              : "document"),
          name: locked.itemName,
          source: locked.objectKey,
          metadata: {
            contentType: locked.declaredContentType,
            size: locked.expectedByteSize,
            originalFileName: locked.originalFileName,
            uploadSessionId: locked.id,
          },
          processingStatus: "pending",
        })
        .returning({ id: repositoryItems.id });
      if (!item) throw new Error("Failed to create repository item");

      const [version] = await tx
        .insert(repositoryItemVersions)
        .values({
          itemId: item.id,
          versionNumber: 1,
          sourceKind: "upload",
          sourceRevision: sourceRevisionForObjectKey(locked.objectKey),
          objectKey: locked.objectKey,
          declaredContentType: locked.declaredContentType,
          byteSize: locked.expectedByteSize,
          // Never promote a caller-declared digest to verified provenance.
          // A later checksum stage may populate this field from object bytes.
          sha256: null,
          storageStatus: "quarantined",
          inspectionStatus: "pending",
          processingStatus: "pending",
          processorVersion: CONTENT_PROCESSOR_CONTRACT_VERSION,
          metadata: { originalFileName: locked.originalFileName },
          createdBy: locked.createdBy,
        })
        .returning({ id: repositoryItemVersions.id });
      if (!version) throw new Error("Failed to create repository item version");

      const [job] = await tx
        .insert(repositoryProcessingJobs)
        .values({
          itemVersionId: version.id,
          stage: "inspect",
          status: "pending",
          idempotencyKey: buildProcessingIdempotencyKey(version.id, "inspect"),
          maxAttempts: CONTENT_PROCESSING_MAX_ATTEMPTS,
        })
        .returning({ id: repositoryProcessingJobs.id });
      if (!job) throw new Error("Failed to create repository processing job");

      await tx
        .update(repositoryItems)
        .set({ currentVersionId: version.id, updatedAt: now })
        .where(eq(repositoryItems.id, item.id));
      await tx
        .update(repositoryUploadSessions)
        .set({
          itemVersionId: version.id,
          status: "completed",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(repositoryUploadSessions.id, locked.id));

      return {
        itemId: item.id,
        itemVersionId: version.id,
        processingJobId: job.id,
        replayed: false,
      };
    },
    "contentPlatform.completeRepositoryUpload"
  );
}
