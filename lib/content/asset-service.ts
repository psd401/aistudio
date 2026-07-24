/**
 * Immutable authored raster upload, completion, listing, and read service (#1284).
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import {
  executeQuery,
  executeTransaction,
} from "@/lib/db/drizzle-client";
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
import {
  actorKindOf,
  agentIdOf,
  authorUserIdOf,
} from "./helpers";
import {
  ConflictError,
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

function checksumBase64(base64url: string): string {
  return Buffer.from(base64url, "base64url").toString("base64");
}

function validateInitiate(input: InitiateContentAssetInput): asserts input is
  InitiateContentAssetInput & { contentType: ContentAssetContentType } {
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
    throw new ValidationError("Asset sha256 must be a base64url SHA-256 digest");
  }
  if (
    input.filename.trim().length === 0 ||
    input.filename.length > 255 ||
    /[\0\r\n/\\]/.test(input.filename)
  ) {
    throw new ValidationError("Asset filename is invalid");
  }
  for (const [name, value] of [
    ["width", input.width],
    ["height", input.height],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) ||
        value < 1 ||
        value > CONTENT_ASSET_MAX_DIMENSION)
    ) {
      throw new ValidationError(`Asset ${name} is outside the allowed range`);
    }
  }
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
  assetId: string
): Promise<ContentAssetRow | null> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(contentAssets)
        .where(
          and(
            eq(contentAssets.id, assetId),
            eq(contentAssets.objectId, objectId)
          )
        )
        .limit(1),
    "content.assets.get"
  );
  return rows[0] ?? null;
}

async function markRejected(
  assetId: string,
  rejectionCode: string
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
            inArray(contentAssets.state, ["pending", "quarantined"])
          )
        ),
    "content.assets.reject"
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

export const contentAssetService = {
  async initiate(
    req: Requester,
    objectId: string,
    input: InitiateContentAssetInput
  ): Promise<InitiatedContentAsset> {
    validateInitiate(input);
    const object = await contentService.loadForEdit(req, objectId);
    const id = randomUUID();
    const objectKey = s3Store.assetKey(object.id, id);
    const uploadKey = s3Store.assetUploadKey(object.id, id);
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
    const checksum = checksumBase64(input.sha256);
    let uploadUrl: string;
    try {
      uploadUrl = await s3Store.signedAssetUploadUrl({
        key: uploadKey,
        contentType: input.contentType,
        contentLength: input.byteLength,
        checksumSha256: checksum,
        ttlSeconds: UPLOAD_TTL_SECONDS,
      });
    } catch {
      throw new StorageError("Asset upload storage is temporarily unavailable");
    }
    const rows = await executeQuery(
      (db) =>
        db
          .insert(contentAssets)
          .values({
            id,
            objectId: object.id,
            uploaderActor: actorKindOf(req),
            uploaderUserId: authorUserIdOf(req),
            uploaderAgentId: agentIdOf(req),
            filename: input.filename.trim(),
            objectKey,
            uploadKey,
            contentType: input.contentType,
            byteLength: input.byteLength,
            sha256: input.sha256,
            width: input.width ?? null,
            height: input.height ?? null,
            purpose: input.purpose,
            uploadExpiresAt: expiresAt,
          })
          .returning(),
      "content.assets.initiate"
    );
    const row = rows[0];
    if (!row) throw new StorageError("Failed to reserve the asset upload");
    return {
      ...dto(row),
      upload: {
        method: "PUT",
        url: uploadUrl,
        headers: {
          "content-type": input.contentType,
          "x-amz-checksum-sha256": checksum,
        },
        expiresAt: expiresAt.toISOString(),
      },
    };
  },

  async complete(
    req: Requester,
    objectId: string,
    assetId: string,
    input: { sha256: string }
  ): Promise<ContentAssetDTO> {
    await contentService.loadForEdit(req, objectId);
    const asset = await loadAsset(objectId, assetId);
    if (!asset) throw new NotFoundError("Content asset not found");
    if (input.sha256 !== asset.sha256) {
      throw new ConflictError("Completion checksum does not match initiation");
    }
    if (asset.state === "ready") return dto(asset);
    if (asset.state !== "pending" && asset.state !== "quarantined") {
      throw new ConflictError("Content asset cannot be completed from this state", {
        state: asset.state,
      });
    }
    if (asset.uploadExpiresAt.getTime() < Date.now()) {
      throw new ConflictError("Content asset upload has expired");
    }
    if (!isContentAssetContentType(asset.contentType)) {
      await markRejected(asset.id, "UNSUPPORTED_DECLARED_MIME");
      throw new ValidationError("Stored asset MIME type is unsupported", {
        rejectionCode: "UNSUPPORTED_DECLARED_MIME",
      });
    }

    let source: Uint8Array;
    try {
      source = await s3Store.getBytesBounded(
        asset.uploadKey,
        CONTENT_ASSET_MAX_BYTES + 1
      );
    } catch {
      throw new StorageError("Uploaded asset bytes are unavailable");
    }
    if (source.byteLength !== asset.byteLength) {
      await markRejected(asset.id, "BYTE_LENGTH_MISMATCH");
      throw new ValidationError("Uploaded asset byte length does not match");
    }
    const actualSha256 = createHash("sha256")
      .update(source)
      .digest("base64url");
    if (actualSha256 !== asset.sha256) {
      await markRejected(asset.id, "CHECKSUM_MISMATCH");
      throw new ValidationError("Uploaded asset checksum does not match", {
        rejectionCode: "CHECKSUM_MISMATCH",
      });
    }

    let normalized: Awaited<ReturnType<typeof normalizeContentAsset>>;
    try {
      normalized = await normalizeContentAsset({
        source,
        declaredContentType: asset.contentType,
        declaredWidth: asset.width ?? undefined,
        declaredHeight: asset.height ?? undefined,
      });
    } catch (error) {
      await markRejected(asset.id, rejectionCode(error));
      void s3Store.deleteKey(asset.uploadKey).catch(() => undefined);
      throw error;
    }

    try {
      await s3Store.putBytes(
        asset.objectKey,
        normalized.bytes,
        normalized.contentType
      );
    } catch {
      throw new StorageError("Normalized asset storage is temporarily unavailable");
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
              inArray(contentAssets.state, ["pending", "quarantined"])
            )
          )
          .returning(),
      "content.assets.complete"
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
      "content.assets.list"
    );
    return rows.map(dto);
  },

  async get(
    req: Requester,
    objectId: string,
    assetId: string
  ): Promise<ContentAssetDTO> {
    const object = await contentService.get(req, objectId);
    const asset = await loadAsset(object.id, assetId);
    if (!asset) throw new NotFoundError("Content asset not found");
    return dto(asset);
  },

  async readBytes(
    req: Requester,
    assetId: string
  ): Promise<{ bytes: Uint8Array; contentType: string; etag: string }> {
    const rows = await executeQuery(
      (db) =>
        db
          .select()
          .from(contentAssets)
          .where(eq(contentAssets.id, assetId))
          .limit(1),
      "content.assets.read.resolve"
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
                contentVersionAssets.versionId
              )
            )
            .innerJoin(
              contentObjects,
              eq(contentObjects.id, contentPublications.objectId)
            )
            .where(
              and(
                eq(contentVersionAssets.assetId, asset.id),
                eq(contentPublications.objectId, object.id),
                eq(contentPublications.destination, "public_web"),
                eq(contentPublications.status, "live"),
                eq(contentObjects.visibilityLevel, "public")
              )
            )
            .limit(1),
        "content.assets.read.publicGate"
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
        normalizedByteLength
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
  limit = CLEANUP_BATCH_SIZE
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
            lt(contentAssets.uploadExpiresAt, new Date())
          )
        )
        .limit(bounded),
    "content.assets.cleanup.select"
  );
  if (expired.length === 0) return 0;
  await Promise.allSettled(
    expired.map((asset) => s3Store.deleteKey(asset.uploadKey))
  );
  const deleted = await executeTransaction(
    (tx) =>
      tx
        .update(contentAssets)
        .set({ state: "deleted" })
        .where(
          and(
            inArray(contentAssets.id, expired.map((asset) => asset.id)),
            eq(contentAssets.state, "pending"),
            lt(contentAssets.uploadExpiresAt, new Date())
          )
        )
        .returning({ id: contentAssets.id }),
    "content.assets.cleanup.mark"
  );
  return deleted.length;
}
