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
