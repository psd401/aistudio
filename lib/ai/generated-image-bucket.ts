import { S3Client } from '@aws-sdk/client-s3';
import { Settings } from '@/lib/settings-manager';

/**
 * The single resolver for the bucket that holds Nexus generated images.
 *
 * `storeImageInS3` writes generated images here, and the Nexus edit path reads
 * them back from here by key (`resolvePreviousGeneratedImageReferences`). Both
 * must use this function: the generic S3 client (`lib/aws/s3-client.ts`)
 * resolves its bucket from the database `S3_BUCKET` setting instead, which is
 * not guaranteed to match `DOCUMENTS_BUCKET_NAME`.
 */
export function getGeneratedImageBucket(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.DOCUMENTS_BUCKET_NAME || 'test-documents-bucket';
  }

  if (!process.env.DOCUMENTS_BUCKET_NAME) {
    throw new Error('DOCUMENTS_BUCKET_NAME environment variable is required');
  }

  return process.env.DOCUMENTS_BUCKET_NAME;
}

let generatedImageS3Client: S3Client | null = null;

/**
 * The single S3 client for Nexus generated images, in the region from
 * `Settings.getS3()` (database `AWS_REGION` first).
 *
 * `storeImageInS3` writes with it and `/api/images/[...key]` signs the
 * browser's redirect with it. The proxy used to build its own client from
 * environment variables (defaulting to `us-east-1`), so where the configured
 * region differed every proxied image got a URL signed for the wrong region
 * and failed to load (#1900).
 */
export async function getGeneratedImageS3Client(): Promise<S3Client> {
  if (generatedImageS3Client) return generatedImageS3Client;
  const s3Config = await Settings.getS3();
  generatedImageS3Client = new S3Client({ region: s3Config.region || 'us-west-2' });
  return generatedImageS3Client;
}

/** Server-written key prefix for a conversation's generated images. */
export function generatedImageKeyPrefix(conversationId: string): string {
  return `v2/generated-images/${conversationId}/`;
}

/**
 * The authenticated path a browser should load a generated image from (#1900).
 *
 * Browsers must NOT be handed the raw S3 presigned URL: those expire an hour
 * after generation and fail intermittently with `InvalidToken`, which is why
 * exports already go through a proxy route. `/api/images/[...key]` re-checks
 * the session and the conversation's ownership on every load and re-signs
 * against `getGeneratedImageBucket()`, so a reloaded conversation renders from
 * a URL that is still valid and still authorized.
 *
 * Each path segment is encoded because the catch-all route decodes them again
 * before rejoining the key.
 */
export function generatedImageProxyPath(s3Key: string): string {
  return `/api/images/${s3Key.split('/').map(encodeURIComponent).join('/')}`;
}
