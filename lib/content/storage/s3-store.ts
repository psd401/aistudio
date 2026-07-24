/**
 * Atrium S3 store
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0). See docs/features/atrium-design-spec.md §6.1 / §13.1.
 *
 * Reads/writes content bodies and rendered snapshots under the `atrium/` prefix of
 * the existing documents bucket. Unlike `lib/aws/s3-client.ts` (which namespaces
 * every key under `{userId}/` and is tuned for user uploads), Atrium needs
 * deterministic, content-addressed keys:
 *
 *   atrium/objects/{objectId}/v{n}/source.md
 *   atrium/objects/{objectId}/v{n}/render.html
 *   atrium/objects/{objectId}/v{n}/artifact.{html|jsx}
 *   atrium/objects/{objectId}/assets/{assetId}
 *
 * Bucket + region resolve from `Settings.getS3()` (the same source the existing
 * S3 client uses), so a deployment configures one bucket and Atrium shares it.
 */

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Settings } from "@/lib/settings-manager";
import { ErrorFactories } from "@/lib/error-utils";

/** The S3 key prefix all Atrium objects live under. */
export const ATRIUM_PREFIX = "atrium";

// No module-level config cache: `Settings.getS3()` already memoizes with a
// 5-minute TTL, so a second indefinite cache here would pin a stale bucket/region
// after a Settings change until container restart. The S3Client is cached but
// keyed on its region and rebuilt when the region changes.
let cachedClient: { region: string; client: S3Client } | null = null;

/**
 * Optional filesystem-backed store for local E2E runs. Production leaves this
 * unset and always uses S3. Keeping the adapter behind a server-only environment
 * variable lets a freshly reset local database exercise snapshot reads/writes
 * without contacting or mutating an AWS bucket.
 */
function getLocalStorageRoot(): string | null {
  const configured = process.env.ATRIUM_LOCAL_STORAGE_DIR?.trim();
  return configured ? resolve(configured) : null;
}

/** Resolve an Atrium key below the configured root and reject path escape. */
function resolveLocalKey(root: string, key: string): string {
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw ErrorFactories.validationFailed([
      { field: "key", message: "Invalid storage key: path escapes local root" },
    ]);
  }
  return target;
}

async function countLocalFiles(directory: string): Promise<number> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return 0;
    }
    throw error;
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countLocalFiles(resolve(directory, entry.name));
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

async function getConfig(): Promise<{ bucket: string; region: string }> {
  const config = await Settings.getS3();
  return {
    bucket: config.bucket || "aistudio-documents",
    region: config.region || "us-east-1",
  };
}

async function getClient(): Promise<S3Client> {
  const { region } = await getConfig();
  if (cachedClient && cachedClient.region === region) return cachedClient.client;
  // Credentials come from the IAM role in AWS, or the local AWS profile in dev.
  const client = new S3Client({ region });
  cachedClient = { region, client };
  return client;
}

/**
 * Reject path segments that could escape the deterministic key layout (path
 * traversal / prefix injection). Current callers pass hardcoded literals or
 * enum-derived filenames, but assets (Phase 1) will pass externally-supplied ids.
 */
function assertSafeSegment(segment: string, field: string): void {
  if (!segment || /[/\\]|\.\./.test(segment)) {
    throw ErrorFactories.validationFailed([
      { field, message: `Invalid ${field}: must not contain '/', '\\', or '..'` },
    ]);
  }
}

/** Clear the cached S3 client (call after S3 settings change). */
export function clearAtriumS3Cache(): void {
  cachedClient = null;
}

async function readStreamToString(body: unknown): Promise<string> {
  // The AWS SDK v3 Body has transformToString() in both Node and browser builds.
  const maybe = body as { transformToString?: () => Promise<string> } | null;
  if (maybe && typeof maybe.transformToString === "function") {
    return maybe.transformToString();
  }
  throw ErrorFactories.sysInternalError(
    "S3 object body is not readable as a string"
  );
}

async function readStreamToBoundedUtf8(
  body: unknown,
  maxBytes: number
): Promise<string> {
  const maybe = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  } | null;
  if (!maybe || typeof maybe.transformToByteArray !== "function") {
    throw ErrorFactories.sysInternalError(
      "S3 object body does not support bounded reads"
    );
  }
  const bytes = await maybe.transformToByteArray();
  if (bytes.byteLength > maxBytes) {
    throw ErrorFactories.validationFailed([
      {
        field: "body",
        message: `Stored content exceeds the ${maxBytes}-byte read limit`,
      },
    ]);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw ErrorFactories.validationFailed([
      { field: "body", message: "Stored content is not valid UTF-8" },
    ]);
  }
}

export const s3Store = {
  /**
   * Build the canonical S3 key for a content object's per-version file.
   * @example s3Store.key("abc", 1, "source.md") // "atrium/objects/abc/v1/source.md"
   */
  key(objectId: string, version: number, file: string): string {
    assertSafeSegment(objectId, "objectId");
    assertSafeSegment(file, "file");
    if (!Number.isInteger(version) || version < 1) {
      throw ErrorFactories.validationFailed([
        { field: "version", message: "version must be a positive integer" },
      ]);
    }
    return `${ATRIUM_PREFIX}/objects/${objectId}/v${version}/${file}`;
  },

  /** Build the S3 key for a content object's asset (image/upload). */
  assetKey(objectId: string, assetId: string): string {
    assertSafeSegment(objectId, "objectId");
    assertSafeSegment(assetId, "assetId");
    return `${ATRIUM_PREFIX}/objects/${objectId}/assets/${assetId}`;
  },

  /** Temporary, lifecycle-reaped key used only before image normalization. */
  assetUploadKey(objectId: string, assetId: string): string {
    assertSafeSegment(objectId, "objectId");
    assertSafeSegment(assetId, "assetId");
    return `${ATRIUM_PREFIX}/pending-assets/${objectId}/${assetId}`;
  },

  /**
   * Build the S3 key for an exported OKF bundle (Phase 8, §36.5). Bundles live
   * under `atrium/okf/{collectionId}/{exportId}.json` — collection-scoped rather
   * than object-scoped (a bundle is a collection subtree, not a single object).
   */
  okfBundleKey(collectionId: string, exportId: string): string {
    assertSafeSegment(collectionId, "collectionId");
    assertSafeSegment(exportId, "exportId");
    return `${ATRIUM_PREFIX}/okf/${collectionId}/${exportId}.json`;
  },

  /**
   * Write a text body to S3 at the given key.
   *
   * `contentDisposition` should be `"attachment"` for any key that holds active
   * markup (e.g. `render.html`, artifact html). A presigned read URL for an
   * object stored as `text/html` would otherwise render as a live document on
   * the S3/CloudFront origin; `attachment` forces a download instead, keeping
   * rendering on the app origin where the security model lives.
   */
  async putText(
    key: string,
    body: string,
    contentType: string,
    contentDisposition?: string
  ): Promise<void> {
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      const target = resolveLocalKey(localRoot, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
      return;
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "no-store",
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
      })
    );
  },

  /** Read a text body from S3 at the given key. */
  async getText(key: string): Promise<string> {
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      return readFile(resolveLocalKey(localRoot, key), "utf8");
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!response.Body) {
      throw ErrorFactories.sysInternalError("S3 object has no body", { key });
    }
    return readStreamToString(response.Body);
  },

  /**
   * Read a UTF-8 object with a hard byte cap. Checks metadata before materializing
   * the body and re-checks the received bytes for stores that omit ContentLength.
   */
  async getTextBounded(key: string, maxBytes: number): Promise<string> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw ErrorFactories.validationFailed([
        { field: "maxBytes", message: "maxBytes must be a positive integer" },
      ]);
    }
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      const target = resolveLocalKey(localRoot, key);
      const metadata = await stat(target);
      if (metadata.size > maxBytes) {
        throw ErrorFactories.validationFailed([
          {
            field: "body",
            message: `Stored content exceeds the ${maxBytes}-byte read limit`,
          },
        ]);
      }
      const bytes = await readFile(target);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw ErrorFactories.validationFailed([
          { field: "body", message: "Stored content is not valid UTF-8" },
        ]);
      }
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (response.ContentLength != null && response.ContentLength > maxBytes) {
      throw ErrorFactories.validationFailed([
        {
          field: "body",
          message: `Stored content exceeds the ${maxBytes}-byte read limit`,
        },
      ]);
    }
    if (!response.Body) {
      throw ErrorFactories.sysInternalError("S3 object has no body");
    }
    return readStreamToBoundedUtf8(response.Body, maxBytes);
  },

  /** Read an object as bytes with a metadata and materialized-size bound. */
  async getBytesBounded(key: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw ErrorFactories.validationFailed([
        { field: "maxBytes", message: "maxBytes must be a positive integer" },
      ]);
    }
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      const target = resolveLocalKey(localRoot, key);
      const metadata = await stat(target);
      if (metadata.size > maxBytes) {
        throw ErrorFactories.validationFailed([
          { field: "asset", message: "Stored asset exceeds its byte limit" },
        ]);
      }
      return readFile(target);
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (response.ContentLength != null && response.ContentLength > maxBytes) {
      throw ErrorFactories.validationFailed([
        { field: "asset", message: "Stored asset exceeds its byte limit" },
      ]);
    }
    const body = response.Body as {
      transformToByteArray?: () => Promise<Uint8Array>;
    } | null;
    if (!body || typeof body.transformToByteArray !== "function") {
      throw ErrorFactories.sysInternalError("S3 asset body is not readable");
    }
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maxBytes) {
      throw ErrorFactories.validationFailed([
        { field: "asset", message: "Stored asset exceeds its byte limit" },
      ]);
    }
    return bytes;
  },

  /** Persist normalized immutable bytes at their canonical key. */
  async putBytes(
    key: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void> {
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      const target = resolveLocalKey(localRoot, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      return;
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
        CacheControl: "private, no-store",
      })
    );
  },

  /** Delete one temporary/canonical object. Missing keys are a no-op. */
  async deleteKey(key: string): Promise<void> {
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      await rm(resolveLocalKey(localRoot, key), { force: true });
      return;
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  /**
   * Presign a direct raster upload. The checksum/content type/length are bound
   * into the request so the browser never receives AWS credentials.
   */
  async signedAssetUploadUrl(input: {
    key: string;
    contentType: string;
    contentLength: number;
    checksumSha256: string;
    ttlSeconds?: number;
  }): Promise<string> {
    if (getLocalStorageRoot()) {
      throw ErrorFactories.sysInternalError(
        "Signed asset uploads are unavailable with local Atrium storage"
      );
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    return getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
        ChecksumSHA256: input.checksumSha256,
        CacheControl: "private, no-store",
      }),
      { expiresIn: input.ttlSeconds ?? 900 }
    );
  },

  /**
   * Delete EVERY object under a content object's `atrium/objects/{objectId}/`
   * prefix — all versions (`v{n}/…`) and assets. Used by the hard-delete path
   * AFTER the DB rows are removed (issue: Atrium hard delete). Paginates the
   * listing and batches deletes at the S3 API limit (1000 keys/request).
   *
   * Returns the number of keys deleted. The caller runs this best-effort
   * post-commit: an orphaned S3 key is acceptable (invisible once its DB rows are
   * gone) and logged, so DB commit ordering — commit first, then this — is what
   * guarantees a failure here can never orphan the DB state. This method itself
   * lets a hard AWS error propagate; the caller catches and logs it.
   */
  async deleteObjectTree(objectId: string): Promise<number> {
    assertSafeSegment(objectId, "objectId");
    const localRoot = getLocalStorageRoot();
    if (localRoot) {
      const objectDirectory = resolveLocalKey(
        localRoot,
        `${ATRIUM_PREFIX}/objects/${objectId}`
      );
      const pendingDirectory = resolveLocalKey(
        localRoot,
        `${ATRIUM_PREFIX}/pending-assets/${objectId}`
      );
      const deleted =
        (await countLocalFiles(objectDirectory)) +
        (await countLocalFiles(pendingDirectory));
      await rm(objectDirectory, { recursive: true, force: true });
      await rm(pendingDirectory, { recursive: true, force: true });
      return deleted;
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    let deleted = 0;
    const prefixes = [
      `${ATRIUM_PREFIX}/objects/${objectId}/`,
      `${ATRIUM_PREFIX}/pending-assets/${objectId}/`,
    ];
    for (const prefix of prefixes) {
      let continuationToken: string | undefined;
      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          })
        );
        const keys = (listed.Contents ?? [])
          .map((o) => o.Key)
          .filter((k): k is string => typeof k === "string");
        // Batch delete in chunks of 1000 (the DeleteObjects hard limit).
        for (let i = 0; i < keys.length; i += 1000) {
          const chunk = keys.slice(i, i + 1000);
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
            })
          );
          deleted += chunk.length;
        }
        continuationToken = listed.IsTruncated
          ? listed.NextContinuationToken
          : undefined;
      } while (continuationToken);
    }

    return deleted;
  },

  /** Generate a presigned read URL for the given key (default 5 min TTL). */
  async signedReadUrl(key: string, ttlSeconds = 300): Promise<string> {
    if (getLocalStorageRoot()) {
      throw ErrorFactories.sysInternalError(
        "Signed read URLs are unavailable with local Atrium storage"
      );
    }
    const client = await getClient();
    const { bucket } = await getConfig();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds }
    );
  },
};
