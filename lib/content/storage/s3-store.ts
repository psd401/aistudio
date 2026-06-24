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
  GetObjectCommand,
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

  /** Write a text body to S3 at the given key. */
  async putText(
    key: string,
    body: string,
    contentType: string
  ): Promise<void> {
    const client = await getClient();
    const { bucket } = await getConfig();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
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
