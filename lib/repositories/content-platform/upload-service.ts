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
import { and, eq, sql } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
  toPgRows,
} from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
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
import {
  REPOSITORY_UPLOAD_TEMPORARY_TAGGING,
} from "./upload-state";

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
    byteSize: number;
    metadata: Record<string, string>;
  }): Promise<{ uploadUrl: string }>;
  createMultipartUpload(input: {
    objectKey: string;
    contentType: string;
    byteSize: number;
    partSize: number;
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
export const MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER = 10;
export const MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER = 5 * 1024 ** 3;
export const MAX_ACTIVE_EPHEMERAL_REPOSITORIES_PER_OWNER = 100;

export type RepositoryUploadQuota =
  | "active-session-count"
  | "active-session-bytes"
  | "ephemeral-storage-bytes"
  | "ephemeral-repository-count";

/**
 * A stable, non-sensitive signal for HTTP callers. Product routes may map this
 * to 429 without exposing repository existence, byte totals, or storage keys.
 */
export class RepositoryUploadQuotaExceededError extends Error {
  readonly code = "REPOSITORY_UPLOAD_QUOTA_EXCEEDED";
  readonly httpStatus = 429;

  constructor(readonly quota: RepositoryUploadQuota) {
    super("Repository upload quota exceeded");
    this.name = "RepositoryUploadQuotaExceededError";
  }
}

interface RepositoryUploadQuotaUsage {
  activeUploadCount: number;
  activeUploadBytes: number;
  nexusManagedStorageBytes: number;
  nexusManagedRepositoryCount: number;
  targetHasNexusManagedStorage: boolean;
}

export function repositoryUploadQuotaViolation(input: {
  usage: RepositoryUploadQuotaUsage;
  requestedBytes: number;
  maximumActiveBytes: number;
  repositoryKind: "durable" | "ephemeral" | "system";
  nexusManaged: boolean;
}): RepositoryUploadQuota | null {
  if (
    input.usage.activeUploadCount >= MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER
  ) {
    return "active-session-count";
  }
  if (
    input.usage.activeUploadBytes + input.requestedBytes >
    input.maximumActiveBytes
  ) {
    return "active-session-bytes";
  }
  if (input.repositoryKind !== "ephemeral" && !input.nexusManaged) return null;
  if (
    input.usage.nexusManagedStorageBytes + input.requestedBytes >
    MAX_ACTIVE_EPHEMERAL_BYTES_PER_OWNER
  ) {
    return "ephemeral-storage-bytes";
  }
  const repositoryCountAfterReservation =
    input.usage.nexusManagedRepositoryCount +
    (input.usage.targetHasNexusManagedStorage ? 0 : 1);
  if (
    repositoryCountAfterReservation >
    MAX_ACTIVE_EPHEMERAL_REPOSITORIES_PER_OWNER
  ) {
    return "ephemeral-repository-count";
  }
  return null;
}

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

export function validateRepositoryUploadFile(
  input: Pick<
    InitiateRepositoryUploadInput,
    "itemName" | "fileName" | "contentType" | "byteSize"
  >,
  config: ContentPlatformConfig
): void {
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
  validateRepositoryUploadFile(input, config);
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

export interface RepositoryUploadStorageFactoryOptions {
  config?: { bucket: string; region?: string };
  client?: S3Client;
  signUrl?: typeof getSignedUrl;
}

export async function createRepositoryUploadStorage(
  options: RepositoryUploadStorageFactoryOptions = {}
): Promise<RepositoryUploadStorage> {
  const { bucket, region } =
    options.config ?? (await resolveRepositoryUploadStorageConfig());
  const client = options.client ?? new S3Client({ region });
  const signUrl = options.signUrl ?? getSignedUrl;
  return {
    async createSingleUpload(input) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
        ContentLength: input.byteSize,
        // A presigned PUT remains reusable until it expires. Make the unique
        // source key write-once so a client cannot replace canonical bytes
        // after completion but before the processing worker reads them.
        IfNoneMatch: "*",
        Tagging: REPOSITORY_UPLOAD_TEMPORARY_TAGGING,
        Metadata: input.metadata,
      });
      return {
        uploadUrl: await signUrl(client, command, {
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
          Tagging: REPOSITORY_UPLOAD_TEMPORARY_TAGGING,
          Metadata: input.metadata,
        })
      );
      if (!created.UploadId) throw new Error("S3 did not return a multipart upload id");
      const uploadId = created.UploadId;
      try {
        const partUrls = await Promise.all(
          Array.from({ length: input.partCount }, async (_, index) => {
            const partNumber = index + 1;
            return {
              partNumber,
              uploadUrl: await signUrl(
                client,
                new UploadPartCommand({
                  Bucket: bucket,
                  Key: input.objectKey,
                  UploadId: uploadId,
                  PartNumber: partNumber,
                  ContentLength:
                    partNumber === input.partCount
                      ? input.byteSize -
                        input.partSize * (input.partCount - 1)
                      : input.partSize,
                }),
                { expiresIn: UPLOAD_EXPIRY_SECONDS }
              ),
            };
          })
        );
        return { uploadId, partUrls };
      } catch (signingError) {
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: input.objectKey,
              UploadId: uploadId,
            })
          );
        } catch (abortError) {
          throw new AggregateError(
            [signingError, abortError],
            "Failed to sign and abort repository multipart upload"
          );
        }
        throw signingError;
      }
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

interface UploadSessionReservation {
  sessionId: string;
  repositoryId: number;
  userId: number;
  objectKey: string;
  uploadMethod: "single" | "multipart";
  partSize?: number;
  partCount?: number;
  itemName: string;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  expiresAt: Date;
}

async function reserveUploadSession(
  input: UploadSessionReservation,
  maximumActiveBytes: number
): Promise<void> {
  await executeTransaction(
    async (tx) => {
      // Every producer starts with the repository row. A delete/purge that
      // wins this lock prevents new signed URLs; a reservation that wins is
      // durably visible before deletion evaluates its session fence.
      const repositoryRows = toPgRows<{
        id: number;
        nexus_managed: boolean;
        owner_id: number;
        repository_kind: "durable" | "ephemeral" | "system";
      }>(
        await tx.execute(sql`
          SELECT
            repository.id,
            repository.owner_id,
            repository.repository_kind,
            (
              COALESCE(repository.metadata ->> 'nexusManaged', 'false') = 'true'
              OR EXISTS (
                SELECT 1
                FROM nexus_repository_bindings binding
                WHERE binding.repository_id = repository.id
              )
            ) AS nexus_managed
          FROM knowledge_repositories repository
          WHERE repository.id = ${input.repositoryId}
            AND repository.lifecycle_status = 'active'
            AND (
              repository.expires_at IS NULL
              OR repository.expires_at > NOW()
            )
          FOR UPDATE OF repository
        `)
      );
      const repository = repositoryRows[0];
      if (!repository) {
        throw new Error("Repository is no longer active");
      }

      // This must be a separate statement after the repository lock. Under
      // READ COMMITTED, the subsequent usage statement then receives a fresh
      // snapshot after any previous owner reservation releases the advisory
      // lock, making concurrent quota enforcement deterministic.
      const quotaPrincipals = [
        input.userId,
        ...(repository.repository_kind === "ephemeral" ||
        repository.nexus_managed
          ? [repository.owner_id]
          : []),
      ]
        .filter((principal, index, values) => values.indexOf(principal) === index)
        .sort((left, right) => left - right);
      for (const principal of quotaPrincipals) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${"repository-upload:"} || ${principal}::text, 0)
          )
        `);
      }

      const usageRows = toPgRows<{
        active_upload_count: number | string;
        active_upload_bytes: number | string;
        ephemeral_storage_bytes: number | string;
        ephemeral_storage_repository_count: number | string;
        target_has_ephemeral_storage: boolean;
      }>(
        await tx.execute(sql`
          WITH active_nexus_managed_repositories AS MATERIALIZED (
            SELECT repository.id
            FROM knowledge_repositories repository
            WHERE repository.owner_id = ${repository.owner_id}
              AND repository.lifecycle_status = 'active'
              AND (
                repository.expires_at IS NULL
                OR repository.expires_at > NOW()
              )
              AND (
                repository.repository_kind = 'ephemeral'
                OR COALESCE(
                  repository.metadata ->> 'nexusManaged',
                  'false'
                ) = 'true'
                OR EXISTS (
                  SELECT 1
                  FROM nexus_repository_bindings binding
                  WHERE binding.repository_id = repository.id
                )
              )
          ),
          current_versions AS MATERIALIZED (
            SELECT
              item.repository_id,
              version.id,
              COALESCE(version.byte_size, 0)::bigint AS byte_size
            FROM active_nexus_managed_repositories repository
            JOIN repository_items item
              ON item.repository_id = repository.id
            JOIN repository_item_versions version
              ON version.id = item.current_version_id
          ),
          counted_sessions AS MATERIALIZED (
            SELECT
              session.repository_id,
              session.expected_byte_size::bigint AS byte_size
            FROM active_nexus_managed_repositories repository
            JOIN repository_upload_sessions session
              ON session.repository_id = repository.id
            WHERE (
                session.status IN ('initiated', 'uploading', 'uploaded')
                AND session.expires_at > NOW()
              )
              OR (
                session.status = 'completed'
                AND NOT EXISTS (
                  SELECT 1
                  FROM current_versions current_version
                  WHERE current_version.id = session.item_version_id
                )
              )
          )
          SELECT
            (
              SELECT COUNT(session.id)::integer
              FROM repository_upload_sessions session
              WHERE session.created_by = ${input.userId}
                AND session.status IN ('initiated', 'uploading', 'uploaded')
                AND session.expires_at > NOW()
            ) AS active_upload_count,
            (
              SELECT COALESCE(SUM(session.expected_byte_size), 0)::bigint
              FROM repository_upload_sessions session
              WHERE session.created_by = ${input.userId}
                AND session.status IN ('initiated', 'uploading', 'uploaded')
                AND session.expires_at > NOW()
            ) AS active_upload_bytes,
            (
              SELECT
                COALESCE(
                  (SELECT SUM(current_version.byte_size) FROM current_versions current_version),
                  0
                ) +
                COALESCE(
                  (SELECT SUM(counted_session.byte_size) FROM counted_sessions counted_session),
                  0
                )
            )::bigint AS ephemeral_storage_bytes,
            (
              SELECT COUNT(*)::integer
              FROM active_nexus_managed_repositories
            ) AS ephemeral_storage_repository_count,
            EXISTS (
              SELECT 1
              FROM active_nexus_managed_repositories repository
              WHERE repository.id = ${input.repositoryId}
            ) AS target_has_ephemeral_storage
        `)
      );
      const usage = usageRows[0];
      if (!usage) throw new Error("Failed to evaluate repository upload quota");
      const violation = repositoryUploadQuotaViolation({
        usage: {
          activeUploadCount: Number(usage.active_upload_count),
          activeUploadBytes: Number(usage.active_upload_bytes),
          nexusManagedStorageBytes: Number(usage.ephemeral_storage_bytes),
          nexusManagedRepositoryCount: Number(
            usage.ephemeral_storage_repository_count
          ),
          targetHasNexusManagedStorage: usage.target_has_ephemeral_storage,
        },
        requestedBytes: input.byteSize,
        maximumActiveBytes,
        repositoryKind: repository.repository_kind,
        nexusManaged: repository.nexus_managed,
      });
      if (violation) throw new RepositoryUploadQuotaExceededError(violation);

      const inserted = toPgRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO repository_upload_sessions (
            id,
            repository_id,
            created_by,
            object_key,
            upload_method,
            part_size,
            part_count,
            item_name,
            original_file_name,
            declared_content_type,
            expected_byte_size,
            status,
            expires_at
          )
          VALUES (
            ${input.sessionId}::uuid,
            ${input.repositoryId},
            ${input.userId},
            ${input.objectKey},
            ${input.uploadMethod},
            ${input.partSize ?? null},
            ${input.partCount ?? null},
            ${input.itemName},
            ${input.originalFileName},
            ${input.contentType},
            ${input.byteSize},
            'initiated',
            ${input.expiresAt.toISOString()}::timestamptz
          )
          RETURNING id
        `)
      );
      if (inserted.length !== 1) {
        throw new Error("Failed to reserve repository upload session");
      }
    },
    "contentPlatform.reserveUploadSession"
  );
}

async function activateUploadSession(
  sessionId: string,
  multipartUploadId?: string
): Promise<void> {
  const updated = await executeQuery(
    (db) =>
      db
        .update(repositoryUploadSessions)
        .set({
          multipartUploadId: multipartUploadId ?? null,
          status: "uploading",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(repositoryUploadSessions.id, sessionId),
            eq(repositoryUploadSessions.status, "initiated")
          )
        )
        .returning({ id: repositoryUploadSessions.id }),
    "contentPlatform.activateUploadSession"
  );
  if (updated.length !== 1) {
    throw new Error("Failed to activate repository upload session");
  }
}

async function abortUploadSession(sessionId: string): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(repositoryUploadSessions)
        .set({ status: "aborted", updatedAt: new Date() })
        .where(eq(repositoryUploadSessions.id, sessionId)),
    "contentPlatform.abortUploadSession"
  );
}

export async function initiateRepositoryUpload(
  input: InitiateRepositoryUploadInput,
  config: ContentPlatformConfig,
  storage?: RepositoryUploadStorage
): Promise<InitiatedRepositoryUpload> {
  validateInitiation(input, config);
  const resolvedStorage = storage ?? (await createRepositoryUploadStorage());
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
  const layout =
    input.byteSize <= SINGLE_UPLOAD_LIMIT
      ? undefined
      : partLayout(input.byteSize);
  const uploadMethod = layout ? "multipart" : "single";

  await reserveUploadSession(
    {
      sessionId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      objectKey,
      uploadMethod,
      partSize: layout?.partSize,
      partCount: layout?.partCount,
      itemName: input.itemName.trim(),
      originalFileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.byteSize,
      expiresAt,
    },
    Math.floor(config.maxFileSizeGb * 1024 ** 3)
  );

  let uploadId: string | undefined;
  try {
    if (!layout) {
      const created = await resolvedStorage.createSingleUpload({
        objectKey,
        contentType: input.contentType,
        byteSize: input.byteSize,
        metadata,
      });
      await activateUploadSession(sessionId);
      return {
        sessionId,
        objectKey,
        uploadMethod: "single",
        uploadUrl: created.uploadUrl,
        expiresAt: expiresAt.toISOString(),
      };
    }

    const created = await resolvedStorage.createMultipartUpload({
      objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      partSize: layout.partSize,
      partCount: layout.partCount,
      metadata,
    });
    uploadId = created.uploadId;
    await activateUploadSession(sessionId, created.uploadId);
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
    await abortUploadSession(sessionId).catch(() => undefined);
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

export function assertRepositoryUploadSessionActive(
  session: Pick<
    typeof repositoryUploadSessions.$inferSelect,
    "status" | "expiresAt"
  >,
  now = new Date()
): void {
  if (
    session.expiresAt.getTime() <= now.getTime() ||
    session.status === "aborted" ||
    session.status === "expired"
  ) {
    throw new Error("Upload session is no longer active");
  }
}

export function assertRepositoryProducerActive(
  repository:
    | Pick<
        typeof knowledgeRepositories.$inferSelect,
        "lifecycleStatus" | "expiresAt"
      >
    | undefined,
  now = new Date()
): void {
  const expiresAt = repository?.expiresAt?.getTime();
  if (
    !repository ||
    repository.lifecycleStatus !== "active" ||
    (expiresAt !== undefined &&
      (Number.isNaN(expiresAt) || expiresAt <= now.getTime()))
  ) {
    throw new Error("Repository is no longer active");
  }
}

export async function completeRepositoryUpload(
  input: CompleteRepositoryUploadInput,
  storage?: RepositoryUploadStorage
): Promise<CompletedRepositoryUpload> {
  const resolvedStorage = storage ?? (await createRepositoryUploadStorage());
  const [session] = await getRepositoryUploadSession(input);
  if (!session) throw new Error("Upload session was not found");
  assertRepositoryUploadSessionActive(session);

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
      // Producer lock order is repository -> upload session. Repository/item
      // deletion takes the same leading lock before fencing sessions, so either
      // completion registers fully before deletion begins or observes the
      // committed deleting state and cannot recreate a manifest after cleanup.
      const [repository] = await tx
        .select({
          lifecycleStatus: knowledgeRepositories.lifecycleStatus,
          expiresAt: knowledgeRepositories.expiresAt,
        })
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, session.repositoryId))
        .limit(1)
        .for("update");
      assertRepositoryProducerActive(repository);

      const [locked] = await tx
        .select()
        .from(repositoryUploadSessions)
        .where(eq(repositoryUploadSessions.id, session.id))
        .limit(1)
        .for("update");
      if (!locked) throw new Error("Upload session was not found");
      // Expiry cleanup claims the same row with FOR UPDATE. Re-check the locked
      // state after all S3 work so a completion that waited behind cleanup
      // cannot register an item whose canonical object was just deleted.
      assertRepositoryUploadSessionActive(locked);

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
