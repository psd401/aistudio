import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  BucketLocationConstraint,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { createError } from "@/lib/error-utils"
import { Settings } from "@/lib/settings-manager"
import { Readable } from "node:stream"

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
  fileName: string
  fileContent: Buffer | Uint8Array | string
  contentType: string
  metadata?: Record<string, string>
}

export interface DocumentUrlParams {
  key: string
  expiresIn?: number // seconds, default 3600 (1 hour)
}

export interface PresignedUploadUrlParams {
  userId: string
  fileName: string
  contentType: string
  fileSize: number
  metadata?: Record<string, string>
  expiresIn?: number // seconds, default 3600 (1 hour)
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
  const key = `${userId}/${timestamp}-${fileName}`

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

// Get a signed URL for a document
export async function getDocumentSignedUrl({
  key,
  expiresIn = 3600,
}: DocumentUrlParams): Promise<string> {
  const s3Client = await getS3Client()
  const config = await getS3Config()
  const bucketName = config.bucket!
  
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
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