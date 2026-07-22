import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  CopyObjectCommand,
  BucketLocationConstraint,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createError } from "@/lib/error-utils"
import { Settings } from "@/lib/settings-manager"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { buildRepositorySourceObjectKey } from "@/lib/repositories/content-platform/object-key"
import { sanitizeFileName } from "@/lib/aws/document-upload"

// Cache S3 config to avoid repeated async calls
let s3ConfigCache: { bucket: string | null; region: string | null } | null = null
let s3ClientCache: S3Client | null = null

// Get S3 configuration with caching
async function getS3Config() {
  if (s3ConfigCache) {
    return s3ConfigCache
  }
  
  const config = await Settings.getS3()
  s3ConfigCache = {
    bucket: config.bucket || "aistudio-documents",
    region: config.region || "us-east-1"
  }
  
  return s3ConfigCache
}

// Get or create S3 client
async function getS3Client() {
  if (s3ClientCache) {
    return s3ClientCache
  }
  
  const config = await getS3Config()
  s3ClientCache = new S3Client({
    region: config.region!,
    // In production, this will use IAM role credentials automatically
    // In development, it will use credentials from ~/.aws/credentials or environment variables
  })
  
  return s3ClientCache
}

// Clear cached S3 configuration and client (call this when settings change)
export function clearS3Cache() {
  s3ConfigCache = null
  s3ClientCache = null
}

export interface UploadDocumentParams {
  userId: string
  repositoryId?: number
  fileName: string
  fileContent: Buffer | Uint8Array | string
  contentType: string
  metadata?: Record<string, string>
}

export interface DocumentUrlParams {
  key: string
  expiresIn?: number // seconds, default 3600 (1 hour)
  responseContentDisposition?: string
}

export interface PresignedUploadUrlParams {
  userId: string
  fileName: string
  contentType: string
  fileSize: number
  metadata?: Record<string, string>
  expiresIn?: number // seconds, default 3600 (1 hour)
}

export interface UploadRepositoryTextSourceParams {
  repositoryId: number
  itemId: number
  userId: number
  fileName: string
  content: string
}

export interface CopyRepositorySourceToCanonicalNamespaceParams {
  repositoryId: number
  sourceKey: string
  fileName: string
}

// Ensure the documents bucket exists
export async function ensureDocumentsBucket(): Promise<void> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    // Check if bucket exists
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }))
  } catch (error) {
    const awsError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (awsError.name === "NotFound" || awsError.$metadata?.httpStatusCode === 404) {
      // Create bucket if it doesn't exist
      try {
        await s3Client.send(
          new CreateBucketCommand({
            Bucket: bucketName,
            ...(config.region && config.region !== "us-east-1" && {
              CreateBucketConfiguration: { LocationConstraint: config.region as BucketLocationConstraint },
            }),
          })
        )

        // Set CORS configuration for browser uploads
        await s3Client.send(
          new PutBucketCorsCommand({
            Bucket: bucketName,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedHeaders: ["*"],
                  AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
                  AllowedOrigins: [
                    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
                  ],
                  ExposeHeaders: ["ETag"],
                  MaxAgeSeconds: 3000,
                },
              ],
            },
          })
        )
      } catch (createErr) {
        throw createError("Failed to create S3 bucket", {
          code: "S3_BUCKET_CREATE_ERROR",
          details: {
            error: createErr instanceof Error ? createErr.message : String(createErr),
            bucket: bucketName,
          }
        })
      }
    } else {
      throw createError("Failed to check S3 bucket", {
        code: "S3_BUCKET_CHECK_ERROR",
        details: {
          error: error instanceof Error ? error.message : String(error),
          bucket: bucketName,
        }
      })
    }
  }
}

// Upload a document to S3
export async function uploadDocument({
  userId,
  repositoryId,
  fileName,
  fileContent,
  contentType,
  metadata = {},
}: UploadDocumentParams): Promise<{ key: string; url: string }> {
  await ensureDocumentsBucket()
  
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!

  const timestamp = Date.now()
  const key = repositoryId == null
    ? `${userId}/${timestamp}-${fileName}`
    : buildRepositorySourceObjectKey(repositoryId, fileName)

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileContent,
      ContentType: contentType,
      Metadata: {
        ...metadata,
        userId,
        uploadedAt: new Date().toISOString(),
      },
    })

    await s3Client.send(command)

    // Generate a signed URL for immediate access
    const url = await getSignedUrl(s3Client, new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    }), { expiresIn: 3600 })

    return { key, url }
  } catch (error) {
    throw createError("Failed to upload document to S3", {
      code: "S3_UPLOAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
      }
    })
  }
}

/**
 * Persist inline repository text as an immutable canonical source object.
 * Keeping it in the repository namespace lets the unified processor and
 * storage cleanup use the same lifecycle as browser-uploaded files.
 */
export async function uploadRepositoryTextSource({
  repositoryId,
  itemId,
  userId,
  fileName,
  content,
}: UploadRepositoryTextSourceParams): Promise<{ key: string; byteSize: number }> {
  await ensureDocumentsBucket()

  const s3Client = await getS3Client()
  const config = await getS3Config()
  const body = Buffer.from(content, "utf8")
  const key = buildRepositorySourceObjectKey(repositoryId, fileName, randomUUID())

  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.bucket!,
      Key: key,
      Body: body,
      ContentType: "text/plain",
      Metadata: {
        repositoryId: repositoryId.toString(),
        itemId: itemId.toString(),
        userId: userId.toString(),
        sourceKind: "text",
        uploadedAt: new Date().toISOString(),
      },
    })
  )

  return { key, byteSize: body.byteLength }
}

/**
 * Copy a legacy repository source into the immutable namespace accepted by the
 * unified processor. S3 preserves source metadata, content type, and tags by
 * default because this request supplies no replacement directives.
 */
export async function copyRepositorySourceToCanonicalNamespace({
  repositoryId,
  sourceKey,
  fileName,
}: CopyRepositorySourceToCanonicalNamespaceParams): Promise<{ key: string }> {
  if (!sourceKey.trim() || sourceKey.includes("..")) {
    throw new Error("A safe source object key is required")
  }
  await ensureDocumentsBucket()

  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  const safeFileName = sanitizeFileName(fileName)
  const key = buildRepositorySourceObjectKey(repositoryId, safeFileName)
  const encodedSourceKey = sourceKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")

  await s3Client.send(
    new CopyObjectCommand({
      Bucket: bucketName,
      Key: key,
      CopySource: `/${bucketName}/${encodedSourceKey}`,
    })
  )

  return { key }
}

// Get a signed URL for a document
export async function getDocumentSignedUrl({
  key,
  expiresIn = 3600,
  responseContentDisposition,
}: DocumentUrlParams): Promise<string> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    })

    const url = await getSignedUrl(s3Client, command, { expiresIn })
    return url
  } catch (error) {
    throw createError("Failed to generate signed URL", {
      code: "S3_SIGNED_URL_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      }
    })
  }
}

// Delete a document from S3
export async function deleteDocument(key: string): Promise<void> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    })

    await s3Client.send(command)
  } catch (error) {
    throw createError("Failed to delete document from S3", {
      code: "S3_DELETE_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      }
    })
  }
}

/**
 * Delete every current object below a repository-owned prefix. The documents
 * bucket is versioned, so S3 retains non-current versions according to the
 * bucket lifecycle policy while the application-visible objects disappear
 * immediately. Pagination is required because one item can accumulate more
 * than 1,000 processor artifacts across versions.
 */
export async function deleteRepositoryObjectsByPrefix(
  prefix: string
): Promise<number> {
  const repositoryArtifactPrefix =
    /^repositories\/[1-9]\d*\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/i
  if (!repositoryArtifactPrefix.test(prefix)) {
    throw createError("Invalid repository object prefix", {
      code: "S3_PREFIX_VALIDATION_ERROR",
      details: { prefix },
    })
  }

  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  let deleted = 0
  let continuationToken: string | undefined

  try {
    do {
      const listed = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      )
      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === "string")

      for (let index = 0; index < keys.length; index += 1000) {
        const batch = keys.slice(index, index + 1000)
        const removed = await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: batch.map((Key) => ({ Key })),
              Quiet: true,
            },
          })
        )
        if ((removed.Errors?.length ?? 0) > 0) {
          throw createError("S3 rejected one or more repository object deletions", {
            code: "S3_PREFIX_DELETE_PARTIAL_ERROR",
            details: {
              prefix,
              failedKeys: removed.Errors?.flatMap((failure) =>
                failure.Key ? [failure.Key] : []
              ),
            },
          })
        }
        deleted += batch.length
      }

      if (listed.IsTruncated && !listed.NextContinuationToken) {
        throw createError("S3 returned a truncated repository listing without a cursor", {
          code: "S3_PREFIX_LIST_CURSOR_ERROR",
          details: { prefix },
        })
      }
      continuationToken = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined
    } while (continuationToken)

    return deleted
  } catch (error) {
    throw createError("Failed to delete repository objects from S3", {
      code: "S3_PREFIX_DELETE_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        prefix,
      },
    })
  }
}

// Check if a document exists
export async function documentExists(key: string): Promise<boolean> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    )
    return true
  } catch (error) {
    const awsError = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (awsError.name === "NotFound" || awsError.$metadata?.httpStatusCode === 404) {
      return false
    }
    throw createError("Failed to check document existence", {
      code: "S3_HEAD_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      }
    })
  }
}

export interface DocumentObjectMetadata {
  contentLength: number;
  contentType: string | null;
  eTag: string | null;
  metadata: Record<string, string>;
}

/**
 * Read authoritative object metadata after a browser upload. Completion paths
 * use this before registering a repository item so client-claimed size and MIME
 * values cannot create a misleading or oversized database record.
 */
export async function getDocumentObjectMetadata(
  key: string
): Promise<DocumentObjectMetadata> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const response = await s3Client.send(
    new HeadObjectCommand({ Bucket: config.bucket!, Key: key })
  )
  return {
    contentLength: response.ContentLength ?? 0,
    contentType: response.ContentType ?? null,
    eTag: response.ETag ?? null,
    metadata: response.Metadata ?? {},
  }
}

// List documents for a user
export async function listUserDocuments(
  userId: string,
  maxKeys: number = 1000
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`,
      MaxKeys: maxKeys,
    })

    const response = await s3Client.send(command)
    
    return (response.Contents || []).map((object) => ({
      key: object.Key!,
      size: object.Size || 0,
      lastModified: object.LastModified || new Date(),
    }))
  } catch (error) {
    throw createError("Failed to list user documents", {
      code: "S3_LIST_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        userId,
      }
    })
  }
}

// Generate a presigned URL for uploading a document
export async function generateUploadPresignedUrl({
  userId,
  fileName,
  contentType,
  fileSize,
  metadata = {},
  expiresIn = 3600,
}: PresignedUploadUrlParams): Promise<{ url: string; key: string; fields: Record<string, string> }> {
  await ensureDocumentsBucket()
  
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!

  const timestamp = Date.now()
  const sanitizedFileName = fileName.replace(/[^\w.-]/g, '_')
  const key = `${userId}/${timestamp}-${sanitizedFileName}`

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
      ContentLength: fileSize,
      Metadata: {
        ...metadata,
        userId,
        uploadedAt: new Date().toISOString(),
        originalName: fileName,
      },
    })

    const url = await getSignedUrl(s3Client, command, { expiresIn })

    // Return additional fields that might be needed for the upload
    const fields = {
      'Content-Type': contentType,
      'Content-Length': fileSize.toString(),
    }

    return { url, key, fields }
  } catch (error) {
    throw createError("Failed to generate presigned upload URL", {
      code: "S3_PRESIGNED_URL_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        fileName,
      }
    })
  }
}

// Get object as a stream for efficient processing
export async function getObjectStream(key: string): Promise<{ 
  stream: Readable
  contentType?: string
  contentLength?: number
  metadata?: Record<string, string>
}> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    })

    const response = await s3Client.send(command)
    
    if (!response.Body) {
      throw new Error("No body returned from S3")
    }

    // Convert Web Streams API to Node.js Readable stream
    const stream = response.Body as Readable

    return {
      stream,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
      metadata: response.Metadata,
    }
  } catch (error) {
    throw createError("Failed to get object stream from S3", {
      code: "S3_GET_STREAM_ERROR",
      details: {
        error: error instanceof Error ? error.message : String(error),
        key,
      }
    })
  }
}

// Helper to extract file key from S3 URL
export async function extractKeyFromUrl(url: string): Promise<string | null> {
  try {
    const config = await getS3Config();
    const bucketName = config.bucket!;
    const urlObj = new URL(url)
    // Handle both virtual-hosted-style and path-style URLs
    const pathMatch = urlObj.pathname.match(/^\/([^/]+)\/(.+)$/)
    if (pathMatch && pathMatch[1] === bucketName) {
      return decodeURIComponent(pathMatch[2])
    }
    // For virtual-hosted-style URLs
    if (urlObj.hostname.startsWith(`${bucketName}.`)) {
      return decodeURIComponent(urlObj.pathname.substring(1))
    }
    return null
  } catch {
    return null
  }
}
