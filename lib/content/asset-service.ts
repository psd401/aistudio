/**
 * Immutable authored raster upload, completion, listing, and read service (#1284).
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  contentAssets,
  contentObjects,
  contentPublications,
  contentVersionAssets,
  type ContentAssetInspection,
  type ContentAssetPurpose,
  type ContentAssetRow,
} from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import {
  contentAssetBytesPath,
  serializeContentAssetDirective,
} from "./asset-directive";
import {
  CONTENT_ASSET_MAX_BYTES,
  CONTENT_ASSET_MAX_DIMENSION,
  CONTENT_ASSET_MAX_PIXELS,
  CONTENT_ASSET_PROCESSOR_VERSION,
  isContentAssetContentType,
  normalizeContentAsset,
  type ContentAssetContentType,
} from "./asset-image";
import { contentService } from "./content-service";
import { actorKindOf, agentIdOf, authorUserIdOf } from "./helpers";
import {
  ConflictError,
  IdempotencyKeyReusedError,
  NotFoundError,
  StorageError,
  ValidationError,
} from "./errors";
import { s3Store } from "./storage/s3-store";
import type { Requester } from "./types";

const UPLOAD_TTL_SECONDS = 15 * 60;
const CLEANUP_BATCH_SIZE = 100;
const log = createLogger({ action: "content-assets" });

export interface ContentAssetDTO {
  id: string;
  objectId: string;
  filename: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  width: number | null;
  height: number | null;
  purpose: ContentAssetPurpose;
  state: ContentAssetRow["state"];
  inspection: ContentAssetInspection | null;
  uploadExpiresAt: string;
  readyAt: string | null;
  createdAt: string;
  embedRef: string;
  bytesUrl: string | null;
}

export interface InitiateContentAssetInput {
  filename: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  purpose: ContentAssetPurpose;
  width?: number;
  height?: number;
}

export interface InitiatedContentAsset extends ContentAssetDTO {
  upload: {
    method: "PUT";
    url: string;
    headers: {
      "content-type": string;
      "x-amz-checksum-sha256": string;
    };
    expiresAt: string;
  };
}

export interface ContentAssetInitiationIdempotency {
  /** SHA-256 of the environment/principal/client/route-scoped client key. */
  keyHash: string;
  /** SHA-256 of the stable semantic initiation request. */
  requestHash: string;
}

export interface InitiatedContentAssetResult {
  asset: InitiatedContentAsset;
  /** True when an existing reservation received a replacement upload request. */
  replayed: boolean;
}

function checksumBase64(base64url: string): string {
  return Buffer.from(base64url, "base64url").toString("base64");
}

function storedAssetContentType(value: string): ContentAssetContentType {
  if (!isContentAssetContentType(value)) {
    throw new StorageError("Stored asset content type is invalid");
  }
  return value;
}

function validateAssetFilename(filename: string): void {
  if (
    filename.trim().length === 0 ||
    filename.length > 255 ||
    /[\0\r\n/\\]/.test(filename)
  ) {
    throw new ValidationError("Asset filename is invalid");
  }
}

function validateAssetDimension(
  name: "width" | "height",
  value: number | undefined,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) ||
      value < 1 ||
      value > CONTENT_ASSET_MAX_DIMENSION)
  ) {
    throw new ValidationError(`Asset ${name} is outside the allowed range`);
  }
}

function validateInitiate(
  input: InitiateContentAssetInput,
): asserts input is InitiateContentAssetInput & {
  contentType: ContentAssetContentType;
} {
  if (!isContentAssetContentType(input.contentType)) {
    throw new ValidationError("Only PNG, JPEG, and WebP assets are supported");
  }
  if (
    !Number.isInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > CONTENT_ASSET_MAX_BYTES
  ) {
    throw new ValidationError("Asset byteLength is outside the allowed range");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.sha256)) {
    throw new ValidationError(
      "Asset sha256 must be a base64url SHA-256 digest",
    );
  }
  validateAssetFilename(input.filename);
  validateAssetDimension("width", input.width);
  validateAssetDimension("height", input.height);
  if (
    input.width !== undefined &&
    input.height !== undefined &&
    input.width * input.height > CONTENT_ASSET_MAX_PIXELS
  ) {
    throw new ValidationError("Declared asset pixels exceed the safe limit");
  }
}

function dto(row: ContentAssetRow): ContentAssetDTO {
  return {
    id: row.id,
    objectId: row.objectId,
    filename: row.filename,
    contentType: row.contentType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    purpose: row.purpose,
    state: row.state,
    inspection: row.inspection ?? null,
    uploadExpiresAt: row.uploadExpiresAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    embedRef:
      serializeContentAssetDirective(row.id, row.filename) ??
      `::atrium-asset{id="${row.id}" alt=""}`,
    bytesUrl: row.state === "ready" ? contentAssetBytesPath(row.id) : null,
  };
}

async function loadAsset(
  objectId: string,
  assetId: string,
): Promise<ContentAssetRow | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(contentAssets)
        .where(
          and(
            eq(contentAssets.id, assetId),
            eq(contentAssets.objectId, objectId),
          ),
        )
        .limit(1),
    "content.assets.get",
  );
  return rows[0] ?? null;
}

async function markRejected(
  assetId: string,
  rejectionCode: string,
): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(contentAssets)
        .set({
          state: "rejected",
          rejectedAt: new Date(),
          inspection: { rejectionCode },
        })
        .where(
          and(
            eq(contentAssets.id, assetId),
            inArray(contentAssets.state, ["pending", "quarantined"]),
          ),
        ),
    "content.assets.reject",
  );
}

function rejectionCode(error: unknown): string {
  if (
    error instanceof ValidationError &&
    typeof error.details?.rejectionCode === "string"
  ) {
    return error.details.rejectionCode;
  }
  return "IMAGE_VALIDATION_FAILED";
}

async function loadInitiationReservation(
  objectId: string,
  keyHash: string,
): Promise<ContentAssetRow | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(contentAssets)
        .where(
          and(
            eq(contentAssets.objectId, objectId),
            eq(contentAssets.initiationKeyHash, keyHash),
          ),
        )
        .limit(1),
    "content.assets.initiate.loadReservation",
  );
  return rows[0] ?? null;
}

/**
 * Renew an existing reservation without allowing cleanup to invalidate the
 * replacement request. A cleanup-retired row gets a fresh temporary S3 key;
 * pending rows keep their deterministic key so concurrent retries are safe.
 */
async function recoverInitiationReservation(
  objectId: string,
  idempotency: ContentAssetInitiationIdempotency,
  expiresAt: Date,
): Promise<ContentAssetRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await loadInitiationReservation(
      objectId,
      idempotency.keyHash,
    );
    if (!existing) {
      throw new StorageError("Failed to recover the asset upload reservation");
    }
    if (existing.initiationRequestHash !== idempotency.requestHash) {
      throw new IdempotencyKeyReusedError();
    }

    if (existing.state === "pending" || existing.state === "quarantined") {
      const renewed = await executeQuery(
        (db) =>
          db
            .update(contentAssets)
            .set({ uploadExpiresAt: expiresAt })
            .where(
              and(
                eq(contentAssets.id, existing.id),
                eq(contentAssets.initiationKeyHash, idempotency.keyHash),
                inArray(contentAssets.state, ["pending", "quarantined"]),
              ),
            )
            .returning(),
        "content.assets.initiate.renewReservation",
      );
      if (renewed[0]) return renewed[0];
      continue;
    }

    if (existing.state === "deleted") {
      const replacementUploadKey = s3Store.assetUploadKey(
        objectId,
        existing.id,
        randomUUID(),
      );
      const recovered = await executeQuery(
        (db) =>
          db
            .update(contentAssets)
            .set({
              state: "pending",
              uploadKey: replacementUploadKey,
              uploadExpiresAt: expiresAt,
              inspection: null,
              rejectedAt: null,
            })
            .where(
              and(
                eq(contentAssets.id, existing.id),
                eq(contentAssets.initiationKeyHash, idempotency.keyHash),
                eq(contentAssets.state, "deleted"),
              ),
            )
            .returning(),
        "content.assets.initiate.recoverDeletedReservation",
      );
      if (recovered[0]) return recovered[0];
      continue;
    }

    throw new ConflictError(
      "Content asset initiation cannot be replayed from this state",
      { state: existing.state },
    );
  }
  throw new ConflictError(
    "Content asset initiation lost a reservation state race",
  );
}

type ContentAssetInsert = typeof contentAssets.$inferInsert;

function initiationValues(
  req: Requester,
  objectId: string,
  input: InitiateContentAssetInput & { contentType: ContentAssetContentType },
  idempotency: ContentAssetInitiationIdempotency | undefined,
  expiresAt: Date,
): ContentAssetInsert {
  const id = randomUUID();
  return {
    id,
    objectId,
    uploaderActor: actorKindOf(req),
    uploaderUserId: authorUserIdOf(req),
    uploaderAgentId: agentIdOf(req),
    filename: input.filename.trim(),
    objectKey: s3Store.assetKey(objectId, id),
    uploadKey: s3Store.assetUploadKey(objectId, id),
    contentType: input.contentType,
    byteLength: input.byteLength,
    sha256: input.sha256,
    width: input.width ?? null,
    height: input.height ?? null,
    purpose: input.purpose,
    initiationKeyHash: idempotency?.keyHash ?? null,
    initiationRequestHash: idempotency?.requestHash ?? null,
    uploadExpiresAt: expiresAt,
  };
}

async function signAssetUpload(
  key: string,
  contentType: ContentAssetContentType,
  contentLength: number,
  checksumSha256: string,
): Promise<string> {
  try {
    return await s3Store.signedAssetUploadUrl({
      key,
      contentType,
      contentLength,
      checksumSha256,
      ttlSeconds: UPLOAD_TTL_SECONDS,
    });
  } catch {
    throw new StorageError("Asset upload storage is temporarily unavailable");
  }
}

async function reserveIdempotentAsset(
  values: ContentAssetInsert,
  objectId: string,
  idempotency: ContentAssetInitiationIdempotency,
  expiresAt: Date,
): Promise<{ row: ContentAssetRow; replayed: boolean }> {
  const inserted = await executeQuery(
    (db) =>
      db.insert(contentAssets).values(values).onConflictDoNothing().returning(),
    "content.assets.initiate.reserve",
  );
  if (inserted[0]) return { row: inserted[0], replayed: false };
  const row = await recoverInitiationReservation(
    objectId,
    idempotency,
    expiresAt,
  );
  return { row, replayed: true };
}

async function reserveUnkeyedAsset(
  values: ContentAssetInsert,
  checksum: string,
): Promise<{ row: ContentAssetRow; uploadUrl: string }> {
  const uploadUrl = await signAssetUpload(
    values.uploadKey,
    values.contentType as ContentAssetContentType,
    values.byteLength,
    checksum,
  );
  const inserted = await executeQuery(
    (db) => db.insert(contentAssets).values(values).returning(),
    "content.assets.initiate",
  );
  if (!inserted[0]) {
    throw new StorageError("Failed to reserve the asset upload");
  }
  return { row: inserted[0], uploadUrl };
}

function initiatedAssetResult(
  row: ContentAssetRow,
  uploadUrl: string,
  checksum: string,
  replayed: boolean,
): InitiatedContentAssetResult {
  return {
    asset: {
      ...dto(row),
      upload: {
        method: "PUT",
        url: uploadUrl,
        headers: {
          "content-type": row.contentType,
          "x-amz-checksum-sha256": checksum,
        },
        expiresAt: row.uploadExpiresAt.toISOString(),
      },
    },
    replayed,
  };
}

function assertCompletableAsset(
  asset: ContentAssetRow,
  expectedSha256: string,
): ContentAssetContentType {
  if (expectedSha256 !== asset.sha256) {
    throw new ConflictError("Completion checksum does not match initiation");
  }
  if (asset.state !== "pending" && asset.state !== "quarantined") {
    throw new ConflictError(
      "Content asset cannot be completed from this state",
      {
        state: asset.state,
      },
    );
  }
  if (asset.uploadExpiresAt.getTime() < Date.now()) {
    throw new ConflictError("Content asset upload has expired");
  }
  return storedAssetContentType(asset.contentType);
}

async function loadAndVerifyAssetSource(
  asset: ContentAssetRow,
): Promise<Uint8Array> {
  let source: Uint8Array;
  try {
    source = await s3Store.getBytesBounded(
      asset.uploadKey,
      CONTENT_ASSET_MAX_BYTES + 1,
    );
  } catch {
    throw new StorageError("Uploaded asset bytes are unavailable");
  }
  if (source.byteLength !== asset.byteLength) {
    await markRejected(asset.id, "BYTE_LENGTH_MISMATCH");
    throw new ValidationError("Uploaded asset byte length does not match");
  }
  const actualSha256 = createHash("sha256").update(source).digest("base64url");
  if (actualSha256 !== asset.sha256) {
    await markRejected(asset.id, "CHECKSUM_MISMATCH");
    throw new ValidationError("Uploaded asset checksum does not match", {
      rejectionCode: "CHECKSUM_MISMATCH",
    });
  }
  return source;
}

async function normalizeUploadedAsset(
  asset: ContentAssetRow,
  source: Uint8Array,
  contentType: ContentAssetContentType,
): Promise<Awaited<ReturnType<typeof normalizeContentAsset>>> {
  try {
    return await normalizeContentAsset({
      source,
      declaredContentType: contentType,
      declaredWidth: asset.width ?? undefined,
      declaredHeight: asset.height ?? undefined,
    });
  } catch (error) {
    await markRejected(asset.id, rejectionCode(error));
    void s3Store.deleteKey(asset.uploadKey).catch(() => undefined);
    throw error;
  }
}

export const contentAssetService = {
  async initiate(
    req: Requester,
    objectId: string,
    input: InitiateContentAssetInput,
    idempotency?: ContentAssetInitiationIdempotency,
  ): Promise<InitiatedContentAssetResult> {
    validateInitiate(input);
    if (
      idempotency &&
      (!/^[0-9a-f]{64}$/.test(idempotency.keyHash) ||
        !/^[0-9a-f]{64}$/.test(idempotency.requestHash))
    ) {
      throw new ValidationError("Invalid asset initiation idempotency digest");
    }
    const object = await contentService.loadForEdit(req, objectId);
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
    const checksum = checksumBase64(input.sha256);
    const values = initiationValues(
      req,
      object.id,
      input,
      idempotency,
      expiresAt,
    );

    if (idempotency) {
      const { row, replayed } = await reserveIdempotentAsset(
        values,
        object.id,
        idempotency,
        expiresAt,
      );
      const uploadUrl = await signAssetUpload(
        row.uploadKey,
        storedAssetContentType(row.contentType),
        row.byteLength,
        checksum,
      );
      return initiatedAssetResult(row, uploadUrl, checksum, replayed);
    }

    // Preserve the unkeyed path's no-orphan behavior on a signing outage.
    const { row, uploadUrl } = await reserveUnkeyedAsset(values, checksum);
    return initiatedAssetResult(row, uploadUrl, checksum, false);
  },

  async complete(
    req: Requester,
    objectId: string,
    assetId: string,
    input: { sha256: string },
  ): Promise<ContentAssetDTO> {
    await contentService.loadForEdit(req, objectId);
    const asset = await loadAsset(objectId, assetId);
    if (!asset) throw new NotFoundError("Content asset not found");
    if (asset.state === "ready") return dto(asset);
    let contentType: ContentAssetContentType;
    try {
      contentType = assertCompletableAsset(asset, input.sha256);
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      await markRejected(asset.id, "UNSUPPORTED_DECLARED_MIME");
      throw new ValidationError("Stored asset MIME type is unsupported", {
        rejectionCode: "UNSUPPORTED_DECLARED_MIME",
      });
    }
    const source = await loadAndVerifyAssetSource(asset);
    const normalized = await normalizeUploadedAsset(asset, source, contentType);

    try {
      await s3Store.putBytes(
        asset.objectKey,
        normalized.bytes,
        normalized.contentType,
      );
    } catch {
      throw new StorageError(
        "Normalized asset storage is temporarily unavailable",
      );
    }
    const inspection: ContentAssetInspection = {
      processorVersion: CONTENT_ASSET_PROCESSOR_VERSION,
      detectedContentType: normalized.contentType,
      sourceWidth: normalized.width,
      sourceHeight: normalized.height,
      normalizedByteLength: normalized.bytes.byteLength,
      normalizedSha256: normalized.sha256,
      metadataStripped: true,
    };
    const rows = await executeQuery(
      (db) =>
        db
          .update(contentAssets)
          .set({
            state: "ready",
            width: normalized.width,
            height: normalized.height,
            inspection,
            readyAt: new Date(),
          })
          .where(
            and(
              eq(contentAssets.id, asset.id),
              inArray(contentAssets.state, ["pending", "quarantined"]),
            ),
          )
          .returning(),
      "content.assets.complete",
    );
    const ready = rows[0] ?? (await loadAsset(objectId, assetId));
    if (!ready || ready.state !== "ready") {
      throw new ConflictError("Content asset completion lost a state race");
    }
    void s3Store.deleteKey(asset.uploadKey).catch((error: unknown) => {
      log.warn("Failed to delete completed temporary asset", {
        assetId: asset.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return dto(ready);
  },

  async list(req: Requester, objectId: string): Promise<ContentAssetDTO[]> {
    const object = await contentService.get(req, objectId);
    const rows = await executeQuery(
      (db) =>
        db
          .select()
          .from(contentAssets)
          .where(eq(contentAssets.objectId, object.id))
          .orderBy(contentAssets.createdAt),
      "content.assets.list",
    );
    return rows.map(dto);
  },

  async get(
    req: Requester,
    objectId: string,
    assetId: string,
  ): Promise<ContentAssetDTO> {
    const object = await contentService.get(req, objectId);
    const asset = await loadAsset(object.id, assetId);
    if (!asset) throw new NotFoundError("Content asset not found");
    return dto(asset);
  },

  async readBytes(
    req: Requester,
    assetId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
    const rows = await executeQuery(
      (db) =>
        db
          .select()
          .from(contentAssets)
          .where(eq(contentAssets.id, assetId))
          .limit(1),
      "content.assets.read.resolve",
    );
    const asset = rows[0];
    if (!asset || asset.state !== "ready") {
      throw new NotFoundError("Content asset not found");
    }
    const object = await contentService.get(req, asset.objectId);
    if (req.kind === "user" && req.userId === null) {
      const publication = await executeQuery(
        (db) =>
          db
            .select({ id: contentPublications.id })
            .from(contentVersionAssets)
            .innerJoin(
              contentPublications,
              eq(
                contentPublications.publishedVersionId,
                contentVersionAssets.versionId,
              ),
            )
            .innerJoin(
              contentObjects,
              eq(contentObjects.id, contentPublications.objectId),
            )
            .where(
              and(
                eq(contentVersionAssets.assetId, asset.id),
                eq(contentPublications.objectId, object.id),
                eq(contentPublications.destination, "public_web"),
                eq(contentPublications.status, "live"),
                eq(contentObjects.visibilityLevel, "public"),
              ),
            )
            .limit(1),
        "content.assets.read.publicGate",
      );
      if (!publication[0]) throw new NotFoundError("Content asset not found");
    }
    const normalizedByteLength = asset.inspection?.normalizedByteLength;
    if (!normalizedByteLength) {
      throw new StorageError("Content asset metadata is incomplete");
    }
    try {
      const bytes = await s3Store.getBytesBounded(
        asset.objectKey,
        normalizedByteLength,
      );
      if (bytes.byteLength !== normalizedByteLength) {
        throw new Error("normalized length mismatch");
      }
      return {
        bytes,
        contentType: asset.contentType,
        etag: `"${asset.inspection?.normalizedSha256 ?? asset.id}"`,
      };
    } catch {
      throw new StorageError("Content asset bytes are temporarily unavailable");
    }
  },
};

/** Bounded cleanup job for expired, uncompleted upload reservations. */
export async function cleanupExpiredContentAssets(
  limit = CLEANUP_BATCH_SIZE,
): Promise<number> {
  const bounded = Math.max(1, Math.min(limit, CLEANUP_BATCH_SIZE));
  const expired = await executeQuery(
    (db) =>
      db
        .select({ id: contentAssets.id, uploadKey: contentAssets.uploadKey })
        .from(contentAssets)
        .where(
          and(
            eq(contentAssets.state, "pending"),
            lt(contentAssets.uploadExpiresAt, new Date()),
          ),
        )
        .limit(bounded),
    "content.assets.cleanup.select",
  );
  if (expired.length === 0) return 0;
  // Retire in PostgreSQL before deleting storage. A concurrent recovery either
  // renews the row first (so this update skips it) or observes `deleted` and
  // switches to a fresh upload key before returning a replacement URL.
  const deleted = await executeTransaction(
    (tx) =>
      tx
        .update(contentAssets)
        .set({ state: "deleted" })
        .where(
          and(
            inArray(
              contentAssets.id,
              expired.map((asset) => asset.id),
            ),
            eq(contentAssets.state, "pending"),
            lt(contentAssets.uploadExpiresAt, new Date()),
          ),
        )
        .returning({
          id: contentAssets.id,
          uploadKey: contentAssets.uploadKey,
        }),
    "content.assets.cleanup.mark",
  );
  await Promise.allSettled(
    deleted.map((asset) => s3Store.deleteKey(asset.uploadKey)),
  );
  return deleted.length;
}
