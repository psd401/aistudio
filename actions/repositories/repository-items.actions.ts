"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeTransaction as drizzleTransaction, executeQuery, repositoryItems, repositoryItemChunks } from "@/lib/db/drizzle-client"
import { eq, and, sql, desc } from "drizzle-orm"
import {
  createRepositoryItem,
  getRepositoryItemById,
  getRepositoryItems,
  getRepositoryItemChunks,
  deleteRepositoryItem,
  updateRepositoryItemStatus
} from "@/lib/db/drizzle"
import {
  assertRepositoryReadAccess,
  assertItemRepositoryReadAccess,
  assertNotSystemManagedRepository
} from "@/lib/repositories/repository-access-guard"
import { type ActionState } from "@/types/actions-types"
import { hasCapabilityAccess } from "@/utils/roles"
import {
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"
import { revalidatePath } from "next/cache"
import {
  copyRepositorySourceToCanonicalNamespace,
  uploadDocument,
  getDocumentObjectMetadata,
  getDocumentSignedUrl,
} from "@/lib/aws/s3-client"
import { queueFileForProcessing, processUrl } from "@/lib/services/file-processing-service"
import { canModifyRepository, getUserIdFromSession } from "./repository-permissions"
import { toContentDispositionValue } from "@/lib/repositories/content-disposition"
import {
  assertCanonicalRetryNotQuarantined,
  deleteRepositoryItemStorage,
  dispatchContentProcessingJob,
  getCanonicalRepositoryItemStatuses,
  isCanonicalUploadContentType,
  isRepositorySourceObjectKey,
  registerCanonicalTextIfEnabled,
  registerCanonicalUploadIfEnabled,
  retryCanonicalRepositoryItem,
} from "@/lib/repositories/content-platform"

// Runtime-validated processing-status union (REV-COR-068): actions are network
// endpoints, so the TS parameter type is not enforced on the wire.
const VALID_PROCESSING_STATUSES = ["pending", "processing", "completed", "failed"] as const
type ProcessingStatus = (typeof VALID_PROCESSING_STATUSES)[number]
function isProcessingStatus(s: string): s is ProcessingStatus {
  return (VALID_PROCESSING_STATUSES as readonly string[]).includes(s)
}

type RepositoryItemType =
  | 'document'
  | 'image'
  | 'audio'
  | 'video'
  | 'url'
  | 'text'

export interface RepositoryItem {
  id: number
  repositoryId: number
  type: RepositoryItemType
  name: string
  source: string
  metadata: Record<string, unknown>
  processingStatus: string
  processingError: string | null
  canRetry?: boolean
  createdAt: Date
  updatedAt: Date
}

export interface RepositoryItemChunk {
  id: number
  itemId: number
  content: string
  embeddingVector: number[] | null
  metadata: Record<string, unknown>
  chunkIndex: number
  tokens: number | null
  createdAt: Date
}

export interface AddDocumentInput {
  repository_id: number
  name: string
  file: {
    content: Buffer | Uint8Array | string
    contentType: string
    size: number
    fileName?: string
  }
}

export interface AddUrlInput {
  repository_id: number
  name: string
  url: string
}

export interface AddTextInput {
  repository_id: number
  name: string
  content: string
}

export interface AddDocumentWithPresignedUrlInput {
  repository_id: number
  name: string
  s3Key: string
  metadata: {
    contentType: string
    size: number
    originalFileName: string
  }
}

async function shadowWriteCanonicalText(
  input: {
    itemId: number
    repositoryId: number
    userId: number
    name: string
    content: string
    traceId: string
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    const canonical = await registerCanonicalTextIfEnabled(input)
    if (!canonical) return

    log.info("Canonical inline text version registered", {
      itemId: input.itemId,
      versionId: canonical.version.id,
      processingJobId: canonical.inspectJob.id,
      created: canonical.created,
    })
    await updateRepositoryItemStatus(input.itemId, "pending", null)
    try {
      await dispatchContentProcessingJob({
        jobId: canonical.inspectJob.id,
        itemVersionId: canonical.version.id,
      })
    } catch (dispatchError) {
      log.warn("Canonical inline text processing is pending scheduled dispatch", {
        processingJobId: canonical.inspectJob.id,
        error:
          dispatchError instanceof Error
            ? dispatchError.message
            : "Unknown error",
      })
    }
  } catch (error) {
    await updateRepositoryItemStatus(
      input.itemId,
      "failed",
      "Canonical content registration failed. Retry this item."
    ).catch((statusError) => {
      log.error("Failed to expose canonical inline text registration failure", {
        itemId: input.itemId,
        error: statusError instanceof Error ? statusError.message : "Unknown error",
      })
    })
    log.error("Canonical inline text shadow write failed", {
      itemId: input.itemId,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

async function shadowWriteCanonicalUpload(
  input: {
    itemId: number
    userId: number
    objectKey: string
    originalFileName: string
    declaredContentType: string
    byteSize: number
    traceId: string
  },
  log: ReturnType<typeof createLogger>
): Promise<void> {
  if (!isCanonicalUploadContentType(input.declaredContentType)) return
  try {
    const canonical = await registerCanonicalUploadIfEnabled(input)
    if (!canonical) return

    log.info("Canonical repository version registered", {
      itemId: input.itemId,
      versionId: canonical.version.id,
      processingJobId: canonical.inspectJob.id,
      created: canonical.created,
    })
    await updateRepositoryItemStatus(input.itemId, "pending", null)
    try {
      await dispatchContentProcessingJob({
        jobId: canonical.inspectJob.id,
        itemVersionId: canonical.version.id,
      })
    } catch (dispatchError) {
      log.warn("Canonical processing is pending scheduled dispatch", {
        processingJobId: canonical.inspectJob.id,
        error:
          dispatchError instanceof Error
            ? dispatchError.message
            : "Unknown error",
      })
    }
  } catch (error) {
    await updateRepositoryItemStatus(
      input.itemId,
      "failed",
      "Canonical content registration failed. Retry this item."
    ).catch((statusError) => {
      log.error("Failed to expose canonical repository registration failure", {
        itemId: input.itemId,
        error: statusError instanceof Error ? statusError.message : "Unknown error",
      })
    })
    log.error("Canonical repository shadow write failed", {
      itemId: input.itemId,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

// Sanitize filename to prevent directory traversal and other security issues
function sanitizeFilename(filename: string): string {
  // Remove any directory components and special characters
  const sanitized = filename
    .replace(/[^\d.A-Za-z-]/g, '_') // Replace special chars with underscore
    .replace(/\.{2,}/g, '.') // Replace multiple dots with single dot
    .replace(/^\.+|\.+$/g, '') // Remove leading/trailing dots
    .slice(0, 255); // Limit length
  return sanitized || "file"
}

// Raw repository item row shape returned by the Drizzle accessors
type RawRepositoryItem = NonNullable<Awaited<ReturnType<typeof getRepositoryItemById>>>

// Convert a raw Drizzle repository item row to the action-layer RepositoryItem type
function mapToRepositoryItem(itemRaw: RawRepositoryItem): RepositoryItem {
  return {
    id: itemRaw.id,
    repositoryId: itemRaw.repositoryId,
    type: itemRaw.type as RepositoryItemType,
    name: itemRaw.name,
    source: itemRaw.source,
    metadata: itemRaw.metadata ?? {},
    processingStatus: itemRaw.processingStatus ?? 'pending',
    processingError: itemRaw.processingError,
    canRetry: false,
    createdAt: itemRaw.createdAt ?? new Date(),
    updatedAt: itemRaw.updatedAt ?? new Date()
  }
}

// Validate addDocumentWithPresignedUrl input; returns a user-facing error message or null when valid
function validatePresignedUrlInput(input: AddDocumentWithPresignedUrlInput): string | null {
  if (!input.name || input.name.trim().length === 0) {
    return "Name is required"
  }

  if (!input.s3Key || input.s3Key.trim().length === 0) {
    return "S3 key is required"
  }

  return null
}

// Validate addDocumentItem input; returns a user-facing error message or null when valid
function validateAddDocumentInput(input: AddDocumentInput): string | null {
  if (!input.name || input.name.trim().length === 0) {
    return "Name is required"
  }

  if (!input.file || !input.file.content) {
    return "File content is required"
  }

  return null
}

// Normalize uploaded file content (base64 string from client or raw bytes) to a Buffer
function toFileBuffer(content: Buffer | Uint8Array | string): Buffer {
  if (typeof content === 'string') {
    // It's a base64 string from the client
    return Buffer.from(content, 'base64')
  }
  // It's already a Buffer or Uint8Array
  return Buffer.from(content)
}

// Determine the file extension from original filename metadata, falling back to the S3 key
function resolveDownloadExtension(item: RepositoryItem): string {
  const metadata = item.metadata as Record<string, unknown> | null

  if (metadata && typeof metadata === 'object' && 'originalFileName' in metadata && typeof metadata.originalFileName === 'string') {
    // Use the original filename's extension
    return metadata.originalFileName.split('.').pop() || ''
  }

  // Extract from S3 key
  const urlParts = item.source.split('/')
  const s3Filename = urlParts[urlParts.length - 1]
  return s3Filename.split('.').pop() || ''
}

// Resolve the download filename, appending the source/original extension when missing
function resolveDownloadFilename(item: RepositoryItem): string {
  let filename = item.name

  // Try to get extension from original filename or S3 key
  const extension = resolveDownloadExtension(item)

  // Add extension if not already present in the name
  if (extension && !filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    filename = `${filename}.${extension}`
  }

  return filename
}


export async function addDocumentItem(
  input: AddDocumentInput
): Promise<ActionState<RepositoryItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("addDocumentItem")
  const log = createLogger({ requestId, action: "addDocumentItem" })
  
  try {
    log.info("Action started: Adding document to repository", {
      repositoryId: input.repository_id,
      fileName: input.name,
      fileSize: input.file?.size
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized document upload attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Document upload denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Validate and sanitize inputs
    const validationError = validateAddDocumentInput(input)
    if (validationError) {
      return { isSuccess: false, message: validationError }
    }

    // Sanitize the filename
    const sanitizedFilename = sanitizeFilename(input.file.fileName || input.name);

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)

    // Never add items to a system-managed repo (the Atrium index, #1056)
    // through the generic API — a foreign item would pollute the retrieval
    // index. Runs BEFORE the ownership check (404-mask precedes 403).
    await assertNotSystemManagedRepository(input.repository_id)

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: input.repository_id, userId })
    const canModify = await canModifyRepository(input.repository_id, userId)
    if (!canModify) {
      log.warn("Document upload denied - not owner", {
        userId,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzOwnerRequired("add items to repository")
    }

    // Convert base64 string back to Buffer if needed
    const fileContent = toFileBuffer(input.file.content)

    // Upload to S3
    log.info("Uploading document to S3", {
      fileName: sanitizedFilename,
      contentType: input.file.contentType,
      size: fileContent.length
    })
    
    const { key, url } = await uploadDocument({
      userId: userId.toString(),
      repositoryId: input.repository_id,
      fileName: sanitizedFilename,
      fileContent,
      contentType: input.file.contentType,
      metadata: {
        repository_id: input.repository_id.toString(),
        type: 'repository_item'
      }
    })
    
    log.debug("Document uploaded to S3 successfully", { s3Key: key })

    // Create repository item via Drizzle
    log.info("Creating repository item in database", {
      repositoryId: input.repository_id,
      type: 'document',
      source: key
    })

    const itemRaw = await createRepositoryItem({
      repositoryId: input.repository_id,
      type: 'document',
      name: input.name,
      source: key,
      metadata: {
        contentType: input.file.contentType,
        size: input.file.size,
        s3_url: url,
        originalFileName: input.file.fileName
      },
      processingStatus: 'pending'
    })

    // Convert to action type
    const item: RepositoryItem = mapToRepositoryItem(itemRaw)

    await shadowWriteCanonicalUpload(
      {
        itemId: item.id,
        userId,
        objectKey: key,
        originalFileName: sanitizedFilename,
        declaredContentType: input.file.contentType,
        byteSize: fileContent.byteLength,
        traceId: requestId,
      },
      log
    )

    // Queue the document for processing
    log.info("Queueing document for processing", {
      itemId: item.id,
      s3Key: key
    })
    
    try {
      await queueFileForProcessing(
        item.id,
        key,
        input.name,
        input.file.contentType
      )
      log.info("Document queued successfully for processing")
    } catch (error) {
      log.error("Failed to queue file for processing", {
        itemId: item.id,
        error: error instanceof Error ? error.message : "Unknown error"
      })
      // Don't fail the upload if queueing fails, just log it
    }

    log.info("Document uploaded successfully", {
      itemId: item.id,
      repositoryId: input.repository_id
    })
    
    timer({ status: "success", itemId: item.id })
    
    revalidatePath(`/repositories/${input.repository_id}`)
    return createSuccess(item, "Document uploaded successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to add document. Please try again or contact support.", {
      context: "addDocumentItem",
      requestId,
      operation: "addDocumentItem",
      metadata: { repositoryId: input.repository_id }
    })
  }
}

export async function addDocumentWithPresignedUrl(
  input: AddDocumentWithPresignedUrlInput
): Promise<ActionState<RepositoryItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("addDocumentWithPresignedUrl")
  const log = createLogger({ requestId, action: "addDocumentWithPresignedUrl" })
  
  try {
    log.info("Action started: Adding document with presigned URL", {
      repositoryId: input.repository_id,
      fileName: input.name
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized presigned upload attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Presigned upload denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }
    
    // Validate inputs
    const validationError = validatePresignedUrlInput(input)
    if (validationError) {
      return { isSuccess: false, message: validationError }
    }

    // Get the user ID from the cognito_sub
    const userId = await getUserIdFromSession(session.sub)

    // Never add items to a system-managed repo (the Atrium index, #1056)
    // through the generic API. Runs BEFORE the ownership check (404 before 403).
    await assertNotSystemManagedRepository(input.repository_id)

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: input.repository_id, userId })
    const canModify = await canModifyRepository(input.repository_id, userId)
    if (!canModify) {
      log.warn("Presigned upload denied - not owner", {
        userId,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzOwnerRequired("add items to repository")
    }

    // S3-key namespace check (REV-SEC-062): the client echoes back a key, but the
    // legitimate upload flow (generateUploadUrl) only ever mints keys under
    // repositories/${repositoryId}/. Reject any other key so a user cannot register
    // an arbitrary documents-bucket object onto their repo and presign-download it.
    if (!isRepositorySourceObjectKey(input.repository_id, input.s3Key)) {
      log.warn("Presigned upload denied - s3Key outside repository namespace", {
        userId,
        repositoryId: input.repository_id
      })
      return { isSuccess: false, message: "Invalid S3 key for this repository" }
    }

    // The client supplied size/type before the PUT. Verify the object that
    // actually landed in S3 before persisting or queueing it. This closes the
    // gap where a caller could request a small allowed upload, PUT different
    // bytes, then register misleading metadata.
    const objectMetadata = await getDocumentObjectMetadata(input.s3Key)
    if (objectMetadata.contentLength !== input.metadata.size) {
      log.warn("Presigned upload size mismatch", {
        repositoryId: input.repository_id,
        expectedSize: input.metadata.size,
        actualSize: objectMetadata.contentLength,
      })
      return { isSuccess: false, message: "Uploaded file size did not match the request" }
    }
    if (
      objectMetadata.contentType &&
      objectMetadata.contentType !== input.metadata.contentType
    ) {
      log.warn("Presigned upload content type mismatch", {
        repositoryId: input.repository_id,
        expectedContentType: input.metadata.contentType,
        actualContentType: objectMetadata.contentType,
      })
      return { isSuccess: false, message: "Uploaded file type did not match the request" }
    }

    // Create repository item with S3 key reference via Drizzle
    log.info("Creating repository item in database", {
      repositoryId: input.repository_id,
      type: 'document',
      s3Key: input.s3Key
    })

    const itemRaw = await createRepositoryItem({
      repositoryId: input.repository_id,
      type: 'document',
      name: input.name,
      source: input.s3Key,
      metadata: {
        contentType: input.metadata.contentType,
        size: input.metadata.size,
        originalFileName: input.metadata.originalFileName,
        uploadedAt: new Date().toISOString(),
        eTag: objectMetadata.eTag,
      },
      processingStatus: 'pending'
    })

    // Convert to action type
    const item: RepositoryItem = {
      id: itemRaw.id,
      repositoryId: itemRaw.repositoryId,
      type: itemRaw.type as RepositoryItemType,
      name: itemRaw.name,
      source: itemRaw.source,
      metadata: itemRaw.metadata ?? {},
      processingStatus: itemRaw.processingStatus ?? 'pending',
      processingError: itemRaw.processingError,
      canRetry: false,
      createdAt: itemRaw.createdAt ?? new Date(),
      updatedAt: itemRaw.updatedAt ?? new Date()
    }

    // Controlled migration path (#1265): when the platform and dual-write
    // switches are enabled, record the immutable quarantined source version and
    // its durable inspection job. The legacy queue remains authoritative until
    // CONTENT_READ_V2_ENABLED is separately enabled. A shadow-write failure is
    // observable but does not make the existing upload disappear from the user;
    // the pending repository item can be reconciled and replayed safely.
    await shadowWriteCanonicalUpload(
      {
        itemId: item.id,
        userId,
        objectKey: input.s3Key,
        originalFileName: input.metadata.originalFileName,
        declaredContentType: input.metadata.contentType,
        byteSize: input.metadata.size,
        traceId: requestId,
      },
      log
    )

    // Queue for processing (embedding generation, etc.)
    log.info("Queueing document for processing", {
      itemId: item.id,
      s3Key: input.s3Key
    })
    
    try {
      await queueFileForProcessing(
        item.id,
        input.s3Key,
        input.metadata.originalFileName,
        input.metadata.contentType
      )
      log.info("Document queued successfully for processing")
    } catch (error) {
      log.error("Failed to queue file for processing", {
        itemId: item.id,
        error: error instanceof Error ? error.message : "Unknown error"
      })
      // Don't fail the upload if queueing fails, just log it
    }

    log.info("Document added successfully via presigned URL", {
      itemId: item.id,
      repositoryId: input.repository_id
    })
    
    timer({ status: "success", itemId: item.id })
    
    revalidatePath(`/repositories/${input.repository_id}`)
    return createSuccess(item, "Document added successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to add document. Please try again or contact support.", {
      context: "addDocumentWithPresignedUrl",
      requestId,
      operation: "addDocumentWithPresignedUrl",
      metadata: { repositoryId: input.repository_id, s3Key: input.s3Key }
    })
  }
}

// Validate URL to ensure it's a valid HTTP/HTTPS URL
function validateUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function addUrlItem(
  input: AddUrlInput
): Promise<ActionState<RepositoryItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("addUrlItem")
  const log = createLogger({ requestId, action: "addUrlItem" })
  
  try {
    log.info("Action started: Adding URL to repository", {
      repositoryId: input.repository_id,
      url: input.url,
      name: input.name
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized URL addition attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("URL addition denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }
    
    // Validate inputs
    if (!input.name || input.name.trim().length === 0) {
      return { isSuccess: false, message: "Name is required" }
    }

    if (!input.url || !validateUrl(input.url)) {
      return { isSuccess: false, message: "Valid HTTP/HTTPS URL is required" }
    }

    // Get the user ID from the cognito_sub
    const userId = await getUserIdFromSession(session.sub)

    // Never add items to a system-managed repo (the Atrium index, #1056)
    // through the generic API. Runs BEFORE the ownership check (404 before 403).
    await assertNotSystemManagedRepository(input.repository_id)

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: input.repository_id, userId })
    const canModify = await canModifyRepository(input.repository_id, userId)
    if (!canModify) {
      log.warn("URL addition denied - not owner", {
        userId,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzOwnerRequired("add items to repository")
    }

    // Create URL repository item via Drizzle
    log.info("Creating URL repository item in database", {
      repositoryId: input.repository_id,
      type: 'url',
      url: input.url
    })

    const itemRaw = await createRepositoryItem({
      repositoryId: input.repository_id,
      type: 'url',
      name: input.name,
      source: input.url,
      metadata: {},
      processingStatus: 'pending'
    })

    // Convert to action type
    const item: RepositoryItem = {
      id: itemRaw.id,
      repositoryId: itemRaw.repositoryId,
      type: itemRaw.type as RepositoryItemType,
      name: itemRaw.name,
      source: itemRaw.source,
      metadata: itemRaw.metadata ?? {},
      processingStatus: itemRaw.processingStatus ?? 'pending',
      processingError: itemRaw.processingError,
      canRetry: false,
      createdAt: itemRaw.createdAt ?? new Date(),
      updatedAt: itemRaw.updatedAt ?? new Date()
    }

    // Process the URL
    log.info("Processing URL content", {
      itemId: item.id,
      url: input.url
    })
    
    try {
      await processUrl(
        item.id,
        input.url,
        input.name
      )
      log.info("URL processed successfully")
    } catch (error) {
      log.error("Failed to process URL", {
        itemId: item.id,
        url: input.url,
        error: error instanceof Error ? error.message : "Unknown error"
      })
      // Don't fail the creation if processing fails, just log it
    }

    log.info("URL added successfully", {
      itemId: item.id,
      repositoryId: input.repository_id
    })

    timer({ status: "success", itemId: item.id })

    revalidatePath(`/repositories/${input.repository_id}`)
    return createSuccess(item, "URL added successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to add URL. Please try again or contact support.", {
      context: "addUrlItem",
      requestId,
      operation: "addUrlItem",
      metadata: { repositoryId: input.repository_id, url: input.url }
    })
  }
}

export async function addTextItem(
  input: AddTextInput
): Promise<ActionState<RepositoryItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("addTextItem")
  const log = createLogger({ requestId, action: "addTextItem" })
  
  try {
    log.info("Action started: Adding text to repository", {
      repositoryId: input.repository_id,
      name: input.name,
      contentLength: input.content.length
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized text addition attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Text addition denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    if (!input.name.trim()) {
      return { isSuccess: false, message: "Name is required" }
    }
    if (!input.content.trim()) {
      return { isSuccess: false, message: "Text content is required" }
    }

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)

    // Never add items to a system-managed repo (the Atrium index, #1056)
    // through the generic API. Runs BEFORE the ownership check (404 before 403).
    await assertNotSystemManagedRepository(input.repository_id)

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: input.repository_id, userId })
    const canModify = await canModifyRepository(input.repository_id, userId)
    if (!canModify) {
      log.warn("Text addition denied - not owner", {
        userId,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzOwnerRequired("add items to repository")
    }

    // Start a transaction to add both the item and its chunk atomically
    log.info("Creating text item with Drizzle transaction", {
      repositoryId: input.repository_id,
      contentLength: input.content.length
    })

    const itemId = await drizzleTransaction(
      async (tx) => {
        // Step 1: Insert the repository item
        const [newItem] = await tx
          .insert(repositoryItems)
          .values({
            repositoryId: input.repository_id,
            type: 'text',
            name: input.name,
            source: input.content,
            metadata: { length: input.content.length },
            processingStatus: 'completed',
          })
          .returning({ id: repositoryItems.id });

        log.debug("Text item created", { itemId: newItem.id });

        // Step 2: Add the chunk in the same transaction
        await tx
          .insert(repositoryItemChunks)
          .values({
            itemId: newItem.id,
            content: input.content,
            chunkIndex: 0,
            metadata: {},
          });

        log.debug("Text chunk added", { itemId: newItem.id, chunkIndex: 0 });

        return newItem.id;
      },
      'addTextItem'
    )

    // Inline text previously bypassed the canonical pipeline entirely. Keep
    // the legacy row for rollback, but shadow-write a repository-scoped text
    // object so Retrieval v2 receives an immutable version, generation,
    // embeddings, and exact citation through the same worker as file uploads.
    await shadowWriteCanonicalText(
      {
        itemId,
        repositoryId: input.repository_id,
        userId,
        name: input.name,
        content: input.content,
        traceId: requestId,
      },
      log
    )

    // Fetch the created item via Drizzle
    log.debug("Fetching created text item", { itemId })
    const itemRaw = await getRepositoryItemById(itemId)

    if (!itemRaw) {
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    // Convert to action type
    const item: RepositoryItem = {
      id: itemRaw.id,
      repositoryId: itemRaw.repositoryId,
      type: itemRaw.type as RepositoryItemType,
      name: itemRaw.name,
      source: itemRaw.source,
      metadata: itemRaw.metadata ?? {},
      processingStatus: itemRaw.processingStatus ?? 'pending',
      processingError: itemRaw.processingError,
      canRetry: false,
      createdAt: itemRaw.createdAt ?? new Date(),
      updatedAt: itemRaw.updatedAt ?? new Date()
    }

    log.info("Text added successfully", {
      itemId,
      repositoryId: input.repository_id
    })

    timer({ status: "success", itemId })

    revalidatePath(`/repositories/${input.repository_id}`)
    return createSuccess(item, "Text added successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to add text. Please try again or contact support.", {
      context: "addTextItem",
      requestId,
      operation: "addTextItem",
      metadata: { repositoryId: input.repository_id }
    })
  }
}

export async function removeRepositoryItem(
  itemId: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("removeRepositoryItem")
  const log = createLogger({ requestId, action: "removeRepositoryItem" })
  
  try {
    log.info("Action started: Removing repository item", { itemId })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized item removal attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Item removal denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the user ID from the cognito_sub
    const userId = await getUserIdFromSession(session.sub)

    // Get the item to check if it's a document (need to delete from S3) via Drizzle
    log.debug("Fetching item details", { itemId })
    const itemRaw = await getRepositoryItemById(itemId)

    if (!itemRaw) {
      log.warn("Item not found for removal", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    // Never mutate a system-managed repo's items (the Atrium index, #1056)
    // through the generic API — deleting one would desync the retrieval index.
    await assertNotSystemManagedRepository(itemRaw.repositoryId)

    // Convert to action type
    const item: RepositoryItem = {
      id: itemRaw.id,
      repositoryId: itemRaw.repositoryId,
      type: itemRaw.type as RepositoryItemType,
      name: itemRaw.name,
      source: itemRaw.source,
      metadata: itemRaw.metadata ?? {},
      processingStatus: itemRaw.processingStatus ?? 'pending',
      processingError: itemRaw.processingError,
      canRetry: false,
      createdAt: itemRaw.createdAt ?? new Date(),
      updatedAt: itemRaw.updatedAt ?? new Date()
    }

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: item.repositoryId, userId })
    const canModify = await canModifyRepository(item.repositoryId, userId)
    if (!canModify) {
      log.warn("Item removal denied - not owner", {
        userId,
        repositoryId: item.repositoryId,
        itemId
      })
      throw ErrorFactories.authzOwnerRequired("remove items from repository")
    }

    // Clean every item type before cascading its version rows. The cleanup
    // service distinguishes stored S3 sources from inline text/URLs and always
    // removes canonical version artifacts. If cleanup fails, preserve the DB
    // rows so the operation can be retried without losing the object manifest.
    log.info("Deleting repository item objects from S3", {
      itemId,
      s3Key: item.source
    })
    const cleanup = await deleteRepositoryItemStorage(item)
    log.info("Repository item objects deleted from S3 successfully", cleanup)

    // Delete from database via Drizzle (cascades to chunks)
    log.info("Deleting item from database", { itemId })
    const deletedCount = await deleteRepositoryItem(itemId)

    if (deletedCount === 0) {
      log.warn("Item not found for deletion", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    log.info("Repository item removed successfully", {
      itemId,
      repositoryId: item.repositoryId
    })
    
    timer({ status: "success", itemId })

    revalidatePath(`/repositories/${item.repositoryId}`)
    return createSuccess(undefined as void, "Item removed successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to remove item. Please try again or contact support.", {
      context: "removeRepositoryItem",
      requestId,
      operation: "removeRepositoryItem",
      metadata: { itemId }
    })
  }
}

export async function listRepositoryItems(
  repositoryId: number
): Promise<ActionState<RepositoryItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listRepositoryItems")
  const log = createLogger({ requestId, action: "listRepositoryItems" })
  
  try {
    log.info("Action started: Listing repository items", { repositoryId })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized list items attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("List items denied - insufficient permissions", {
        userId: session.sub,
        repositoryId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Per-repository authorization: the caller must be able to access this
    // repository (public / owner / grant). Also excludes system-managed repos
    // (the Atrium index, #1056). Closes the IDOR where any capability holder
    // could list a private repo they don't own (REV-COR-061).
    await assertRepositoryReadAccess(repositoryId, session.sub)

    // Fetch repository items via Drizzle
    log.debug("Fetching repository items from database", { repositoryId })
    const [itemsRaw, canonicalStatuses] = await Promise.all([
      getRepositoryItems(repositoryId),
      getCanonicalRepositoryItemStatuses(repositoryId),
    ])

    // Convert to action type
    const items: RepositoryItem[] = itemsRaw.map(item => {
      const canonical = canonicalStatuses.get(item.id)
      return {
        id: item.id,
        repositoryId: item.repositoryId,
        type: item.type as RepositoryItemType,
        name: item.name,
        source: item.source,
        metadata: item.metadata ?? {},
        processingStatus:
          canonical?.processingStatus ?? item.processingStatus ?? 'pending',
        processingError: canonical?.processingError ?? item.processingError,
        canRetry:
          canonical?.canRetry ??
          (item.processingStatus === "failed" &&
            item.processingError?.startsWith("Canonical content registration failed") === true),
        createdAt: item.createdAt ?? new Date(),
        updatedAt: item.updatedAt ?? new Date()
      }
    })

    log.info("Repository items fetched successfully", {
      repositoryId,
      itemCount: items.length
    })

    timer({ status: "success", count: items.length })

    return createSuccess(items, "Items loaded successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to list repository items. Please try again or contact support.", {
      context: "listRepositoryItems",
      requestId,
      operation: "listRepositoryItems",
      metadata: { repositoryId }
    })
  }
}

interface RepositoryItemRetryTarget {
  itemVersionId: string
  processingJobId: string
}

async function prepareRepositoryItemRetry(
  item: RawRepositoryItem,
  userId: number,
  requestId: string
): Promise<RepositoryItemRetryTarget> {
  if (item.currentVersionId) {
    await assertCanonicalRetryNotQuarantined(item.currentVersionId)
  }

  if (item.type === "text") {
    const canonical = await registerCanonicalTextIfEnabled({
      itemId: item.id,
      repositoryId: item.repositoryId,
      userId,
      name: item.name,
      content: item.source,
      traceId: requestId,
    })
    if (!canonical) {
      throw ErrorFactories.sysConfigurationError(
        "Canonical content processing is disabled"
      )
    }
    return {
      itemVersionId: canonical.version.id,
      processingJobId: canonical.inspectJob.id,
    }
  }

  if (
    item.currentVersionId &&
    isRepositorySourceObjectKey(item.repositoryId, item.source)
  ) {
    return retryCanonicalRepositoryItem(item.id, requestId)
  }

  if (!["document", "image", "audio", "video"].includes(item.type)) {
    throw ErrorFactories.invalidInput(
      "item.type",
      item.type,
      "Only stored files and inline text can be reprocessed"
    )
  }

  const metadata = item.metadata ?? {}
  const originalFileName =
    typeof metadata.originalFileName === "string"
      ? metadata.originalFileName
      : item.name
  const copied = await copyRepositorySourceToCanonicalNamespace({
    repositoryId: item.repositoryId,
    sourceKey: item.source,
    fileName: originalFileName,
  })
  const copiedMetadata = await getDocumentObjectMetadata(copied.key)
  const declaredContentType =
    copiedMetadata.contentType ??
    (typeof metadata.contentType === "string" ? metadata.contentType : null)
  if (!declaredContentType || copiedMetadata.contentLength <= 0) {
    throw ErrorFactories.invalidInput(
      "storedSourceMetadata",
      copiedMetadata,
      "A positive content length and content type are required"
    )
  }
  const canonical = await registerCanonicalUploadIfEnabled({
    itemId: item.id,
    userId,
    objectKey: copied.key,
    originalFileName,
    declaredContentType,
    byteSize: copiedMetadata.contentLength,
    traceId: requestId,
  })
  if (!canonical) {
    throw ErrorFactories.sysConfigurationError(
      "Canonical content processing is disabled"
    )
  }
  return {
    itemVersionId: canonical.version.id,
    processingJobId: canonical.inspectJob.id,
  }
}

export async function retryRepositoryItemProcessing(
  itemId: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("retryRepositoryItemProcessing")
  const log = createLogger({ requestId, action: "retryRepositoryItemProcessing" })

  try {
    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    if (!(await hasCapabilityAccess("knowledge-repositories"))) {
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    const item = await getRepositoryItemById(itemId)
    if (!item) throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    await assertNotSystemManagedRepository(item.repositoryId)
    const userId = await getUserIdFromSession(session.sub)
    if (!(await canModifyRepository(item.repositoryId, userId))) {
      throw ErrorFactories.authzOwnerRequired("retry repository processing")
    }

    const retry = await prepareRepositoryItemRetry(item, userId, requestId)
    try {
      await dispatchContentProcessingJob({
        jobId: retry.processingJobId,
        itemVersionId: retry.itemVersionId,
      })
    } catch (dispatchError) {
      // The durable pending job remains eligible for scheduled dispatch.
      log.warn("Retried content is pending scheduled dispatch", {
        itemId,
        processingJobId: retry.processingJobId,
        error:
          dispatchError instanceof Error ? dispatchError.message : "Unknown error",
      })
    }

    revalidatePath(`/repositories/${item.repositoryId}`)
    timer({ status: "success", itemId })
    return createSuccess(undefined as void, "Content processing restarted")
  } catch (error) {
    timer({ status: "error", itemId })
    return handleError(error, "Failed to retry content processing.", {
      context: "retryRepositoryItemProcessing",
      requestId,
      operation: "retryRepositoryItemProcessing",
      metadata: { itemId },
    })
  }
}

export async function searchRepositoryItems(
  repositoryId: number,
  query: string
): Promise<ActionState<{
  items: RepositoryItem[]
  chunks: RepositoryItemChunk[]
}>> {
  const requestId = generateRequestId()
  const timer = startTimer("searchRepositoryItems")
  const log = createLogger({ requestId, action: "searchRepositoryItems" })
  
  try {
    log.info("Action started: Searching repository items", {
      repositoryId,
      query: query.substring(0, 50) // Log first 50 chars of query
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized search attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Search denied - insufficient permissions", {
        userId: session.sub,
        repositoryId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Per-repository authorization (public / owner / grant); also excludes
    // system-managed repos (#1056). Closes the IDOR on item search — this
    // returns chunk CONTENT (REV-COR-061).
    await assertRepositoryReadAccess(repositoryId, session.sub)

    // Search in item names via Drizzle
    log.debug("Searching item names", { repositoryId, query })
    const itemsRaw = await executeQuery(
      (db) =>
        db
          .select()
          .from(repositoryItems)
          .where(
            and(
              eq(repositoryItems.repositoryId, repositoryId),
              sql`LOWER(${repositoryItems.name}) LIKE LOWER(${`%${query}%`})`
            )
          )
          .orderBy(desc(repositoryItems.createdAt)),
      "searchRepositoryItemsByName"
    )

    // Convert to action type
    const items: RepositoryItem[] = itemsRaw.map(item => ({
      id: item.id,
      repositoryId: item.repositoryId,
      type: item.type as RepositoryItemType,
      name: item.name,
      source: item.source,
      metadata: item.metadata ?? {},
      processingStatus: item.processingStatus ?? 'pending',
      processingError: item.processingError,
      canRetry: false,
      createdAt: item.createdAt ?? new Date(),
      updatedAt: item.updatedAt ?? new Date()
    }))

    // Search in chunk content via Drizzle
    log.debug("Searching chunk content", { repositoryId, query })
    const chunksRaw = await executeQuery(
      (db) =>
        db
          .select({
            id: repositoryItemChunks.id,
            itemId: repositoryItemChunks.itemId,
            content: repositoryItemChunks.content,
            embedding: repositoryItemChunks.embedding,
            metadata: repositoryItemChunks.metadata,
            chunkIndex: repositoryItemChunks.chunkIndex,
            tokens: repositoryItemChunks.tokens,
            createdAt: repositoryItemChunks.createdAt,
            itemName: repositoryItems.name,
          })
          .from(repositoryItemChunks)
          .innerJoin(repositoryItems, eq(repositoryItemChunks.itemId, repositoryItems.id))
          .where(
            and(
              eq(repositoryItems.repositoryId, repositoryId),
              sql`LOWER(${repositoryItemChunks.content}) LIKE LOWER(${`%${query}%`})`
            )
          )
          .orderBy(repositoryItemChunks.itemId, repositoryItemChunks.chunkIndex)
          .limit(20),
      "searchRepositoryItemChunks"
    )

    // Convert to action type
    const chunks: (RepositoryItemChunk & { itemName: string })[] = chunksRaw.map(chunk => ({
      id: chunk.id,
      itemId: chunk.itemId,
      content: chunk.content,
      embeddingVector: chunk.embedding as number[] | null,
      metadata: chunk.metadata ?? {},
      chunkIndex: chunk.chunkIndex,
      tokens: chunk.tokens,
      createdAt: chunk.createdAt ?? new Date(),
      itemName: chunk.itemName
    }))

    log.info("Search completed successfully", {
      repositoryId,
      itemCount: items.length,
      chunkCount: chunks.length
    })
    
    timer({ status: "success", itemCount: items.length, chunkCount: chunks.length })
    
    return createSuccess({ items, chunks }, "Search completed successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to search repository items. Please try again or contact support.", {
      context: "searchRepositoryItems",
      requestId,
      operation: "searchRepositoryItems",
      metadata: { repositoryId, query }
    })
  }
}

export async function getItemChunks(
  itemId: number
): Promise<ActionState<RepositoryItemChunk[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getItemChunks")
  const log = createLogger({ requestId, action: "getItemChunks" })
  
  try {
    log.info("Action started: Getting item chunks", { itemId })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized get chunks attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Get chunks denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // A chunk read is a DIRECT read of raw indexed text. Require access to the
    // item's repository (public / owner / grant) — closes the IDOR where any
    // capability holder could read another repo's chunks by item id (REV-COR-061).
    // Also excludes system-managed repos (the Atrium index, #1056), whose
    // per-object visibility is enforced by retrievalService/canView, not
    // repo-level access.
    await assertItemRepositoryReadAccess(itemId, session.sub)

    // Fetch chunks via Drizzle
    log.debug("Fetching chunks from database", { itemId })
    const chunksRaw = await getRepositoryItemChunks(itemId)

    // Convert to action type
    const chunks: RepositoryItemChunk[] = chunksRaw.map(chunk => ({
      id: chunk.id,
      itemId: chunk.itemId,
      content: chunk.content,
      embeddingVector: chunk.embedding as number[] | null,
      metadata: chunk.metadata ?? {},
      chunkIndex: chunk.chunkIndex,
      tokens: chunk.tokens,
      createdAt: chunk.createdAt ?? new Date()
    }))

    log.info("Chunks fetched successfully", {
      itemId,
      chunkCount: chunks.length
    })

    timer({ status: "success", count: chunks.length })

    return createSuccess(chunks, "Chunks loaded successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get item chunks. Please try again or contact support.", {
      context: "getItemChunks",
      requestId,
      operation: "getItemChunks",
      metadata: { itemId }
    })
  }
}

export async function updateItemProcessingStatus(
  itemId: number,
  status: string,
  error?: string
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateItemProcessingStatus")
  const log = createLogger({ requestId, action: "updateItemProcessingStatus" })
  
  try {
    log.info("Action started: Updating item processing status", {
      itemId,
      status,
      hasError: !!error
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized status update attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Status update denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Validate the status string (REV-COR-068): actions are network endpoints, so
    // the TS union is not enforced at runtime — reject anything outside the four
    // states before any write instead of casting an arbitrary string in.
    if (!isProcessingStatus(status)) {
      log.warn("Invalid processing status", { itemId, status })
      return { isSuccess: false, message: "Invalid processing status" }
    }

    // A status write keyed by itemId is a cross-repo write path: without a
    // per-item guard any capability holder could flip processing status on an
    // arbitrary item (IDOR), including rows of the system-managed Atrium index
    // (#1056). Mirror removeRepositoryItem: resolve the item (404 on miss),
    // reject system-managed repos (404-mask), then require ownership (403).
    log.debug("Fetching item for status update", { itemId })
    const itemRaw = await getRepositoryItemById(itemId)
    if (!itemRaw) {
      log.warn("Item not found for status update", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }
    await assertNotSystemManagedRepository(itemRaw.repositoryId)

    const userId = await getUserIdFromSession(session.sub)
    log.debug("Checking repository ownership", { repositoryId: itemRaw.repositoryId, userId })
    const canModify = await canModifyRepository(itemRaw.repositoryId, userId)
    if (!canModify) {
      log.warn("Status update denied - not owner", {
        userId,
        repositoryId: itemRaw.repositoryId,
        itemId
      })
      throw ErrorFactories.authzOwnerRequired("update items in repository")
    }

    // Update processing status via Drizzle
    log.info("Updating processing status in database", {
      itemId,
      status,
      hasError: !!error
    })

    await updateRepositoryItemStatus(itemId, status, error ?? null)

    log.info("Processing status updated successfully", { itemId, status })

    timer({ status: "success", itemId })

    return createSuccess(undefined as void, "Status updated successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to update processing status. Please try again or contact support.", {
      context: "updateItemProcessingStatus",
      requestId,
      operation: "updateItemProcessingStatus",
      metadata: { itemId, status, error }
    })
  }
}

export async function getDocumentDownloadUrl(
  itemId: number
): Promise<ActionState<string>> {
  const requestId = generateRequestId()
  const timer = startTimer("getDocumentDownloadUrl")
  const log = createLogger({ requestId, action: "getDocumentDownloadUrl" })
  
  try {
    log.info("Action started: Getting document download URL", { itemId })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized download URL request")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Download URL denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the item to check if it's a document via Drizzle
    log.debug("Fetching item from database", { itemId })
    const itemRaw = await getRepositoryItemById(itemId)

    if (!itemRaw) {
      log.warn("Item not found for download URL", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    // A download URL is a content-access path. Require access to the item's
    // repository (public / owner / grant) — closes the IDOR by item id. Also
    // excludes system-managed repos (the Atrium index, #1056).
    await assertRepositoryReadAccess(itemRaw.repositoryId, session.sub)

    // Convert to action type
    const item: RepositoryItem = mapToRepositoryItem(itemRaw)

    if (
      item.type !== 'document' &&
      item.type !== 'image' &&
      item.type !== 'audio' &&
      item.type !== 'video'
    ) {
      log.warn("Download URL requested for non-file item", {
        itemId,
        itemType: item.type
      })
      return { isSuccess: false, message: "Item is not a downloadable file" }
    }

    // Defense in depth (REV-SEC-062): never presign a stored source outside this
    // item's own repository namespace — blocks a client-planted key (via
    // addDocumentWithPresignedUrl) from being signed against the shared bucket.
    const expectedPrefix = `repositories/${item.repositoryId}/`
    if (!item.source.startsWith(expectedPrefix)) {
      log.warn("Download URL denied - source outside repository namespace", {
        itemId,
        repositoryId: item.repositoryId
      })
      return { isSuccess: false, message: "Item is not available for download" }
    }

    // Sanitize/encode the display filename before it lands in the reflected
    // Content-Disposition header (REV-COR-071).
    const contentDisposition = toContentDispositionValue(resolveDownloadFilename(item))

    log.info("Generating presigned download URL", {
      itemId,
      s3Key: item.source,
      contentDisposition
    })
    
    const downloadUrl = await getDocumentSignedUrl({
      key: item.source,
      expiresIn: 3600,
      responseContentDisposition: contentDisposition,
    })

    log.info("Download URL generated successfully", {
      itemId,
      expiresIn: 3600
    })
    
    timer({ status: "success", itemId })
    
    return createSuccess(downloadUrl, "Download URL generated")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to generate download URL. Please try again or contact support.", {
      context: "getDocumentDownloadUrl",
      requestId,
      operation: "getDocumentDownloadUrl",
      metadata: { itemId }
    })
  }
}
