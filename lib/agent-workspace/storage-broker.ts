import { createHash } from "node:crypto"
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const MAX_RELATIVE_PATH_LENGTH = 768
const MAX_LIST_KEYS = 1_000
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._@+= -]+$/
const PUBLIC_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".svg",
  ".txt",
  ".webp",
])

let client: S3Client | null = null

function s3Client(): S3Client {
  if (!client) {
    client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" })
  }
  return client
}

function bucketName(): string {
  const bucket = process.env.AGENT_WORKSPACE_BUCKET
  if (!bucket) throw new Error("Agent workspace storage is not configured")
  return bucket
}

export function validateWorkspaceRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.length > MAX_RELATIVE_PATH_LENGTH ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/")
  ) {
    throw new Error("Invalid workspace-relative path")
  }
  const segments = relativePath.split("/")
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    throw new Error("Invalid workspace-relative path")
  }
  return segments.join("/")
}

function validateTrustedPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "")
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    throw new Error("Invalid signed workspace prefix")
  }
  return normalized
}

export function ownerWorkspaceKey(
  signedWorkspacePrefix: string,
  relativePath: string
): string {
  return `${validateTrustedPrefix(signedWorkspacePrefix)}/${validateWorkspaceRelativePath(relativePath)}`
}

export function publicArtifactKey(ownerEmail: string, fileName: string): string {
  const safeName = validateWorkspaceRelativePath(fileName)
  if (safeName.includes("/")) throw new Error("Public artifact name must be a file name")
  const extensionIndex = safeName.lastIndexOf(".")
  const extension = extensionIndex === -1 ? "" : safeName.slice(extensionIndex).toLowerCase()
  if (!PUBLIC_EXTENSIONS.has(extension)) {
    throw new Error("Public artifact type is not allowed")
  }
  const owner = createHash("sha256").update(ownerEmail.toLowerCase()).digest("hex").slice(0, 24)
  return `public-images/${owner}/${safeName}`
}

export function validateOwnerPublicArtifactKey(
  ownerEmail: string,
  key: string
): string {
  const owner = createHash("sha256").update(ownerEmail.toLowerCase()).digest("hex").slice(0, 24)
  const prefix = `public-images/${owner}/`
  if (!key.startsWith(prefix)) throw new Error("Invalid owner public artifact key")
  const fileName = key.slice(prefix.length)
  if (!fileName || fileName.includes("/")) {
    throw new Error("Invalid owner public artifact key")
  }
  publicArtifactKey(ownerEmail, fileName)
  return key
}

export async function listWorkspaceObjects(
  signedWorkspacePrefix: string,
  continuationToken?: string
): Promise<{
  paths: string[]
  continuationToken?: string
}> {
  const prefix = `${validateTrustedPrefix(signedWorkspacePrefix)}/`
  const response = await s3Client().send(
    new ListObjectsV2Command({
      Bucket: bucketName(),
      Prefix: prefix,
      MaxKeys: MAX_LIST_KEYS,
      ContinuationToken: continuationToken,
    })
  )
  return {
    paths: (response.Contents ?? [])
      .map((entry) => entry.Key)
      .filter((key): key is string => Boolean(key?.startsWith(prefix)))
      .map((key) => key.slice(prefix.length))
      .filter(Boolean),
    ...(response.NextContinuationToken
      ? { continuationToken: response.NextContinuationToken }
      : {}),
  }
}

export async function createWorkspaceDownloadUrl(
  signedWorkspacePrefix: string,
  relativePath: string
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: ownerWorkspaceKey(signedWorkspacePrefix, relativePath),
    }),
    { expiresIn: 120 }
  )
}

export async function createWorkspaceUploadUrl(
  signedWorkspacePrefix: string,
  relativePath: string,
  contentType?: string
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: ownerWorkspaceKey(signedWorkspacePrefix, relativePath),
      ...(contentType ? { ContentType: contentType } : {}),
    }),
    { expiresIn: 120 }
  )
}

export async function createPublicArtifactUpload(
  ownerEmail: string,
  fileName: string,
  contentType: string
): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  const key = publicArtifactKey(ownerEmail, fileName)
  const bucket = bucketName()
  const uploadUrl = await getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 120 }
  )
  const region = process.env.AWS_REGION || "us-east-1"
  const encodedKey = key.split("/").map(encodeURIComponent).join("/")
  return {
    key,
    uploadUrl,
    publicUrl: `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`,
  }
}

export async function createPublicArtifactDownloadUrl(
  ownerEmail: string,
  key: string
): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: validateOwnerPublicArtifactKey(ownerEmail, key),
    }),
    { expiresIn: 120 }
  )
}

export function resetWorkspaceStorageClientForTests(): void {
  if (process.env.NODE_ENV === "test") client = null
}
