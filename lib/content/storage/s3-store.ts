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
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Settings } from "@/lib/settings-manager";
import { ErrorFactories } from "@/lib/error-utils";

/** The S3 key prefix all Atrium objects live under. */
export const ATRIUM_PREFIX = "atrium";

// No module-level config cache: `Settings.getS3()` already memoizes with a
// 5-minute TTL, so a second indefinite cache here would pin a stale bucket/region
// after a Settings change until container restart. The S3Client is cached but
// keyed on its region and rebuilt when the region changes.
let cachedClient: { region: string; client: S3Client } | null = null;

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
    const client = await getClient();
    const { bucket } = await getConfig();
    const prefix = `${ATRIUM_PREFIX}/objects/${objectId}/`;

    let deleted = 0;
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

    return deleted;
  },

  /** Generate a presigned read URL for the given key (default 5 min TTL). */
  async signedReadUrl(key: string, ttlSeconds = 300): Promise<string> {
    const client = await getClient();
    const { bucket } = await getConfig();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds }
    );
  },
};
