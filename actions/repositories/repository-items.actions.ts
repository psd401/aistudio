"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL, executeTransaction } from "@/lib/db/data-api-adapter"
import { type ActionState } from "@/types/actions-types"
import { hasToolAccess } from "@/utils/roles"
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
import { uploadDocument, deleteDocument } from "@/lib/aws/s3-client"
import { queueFileForProcessing, processUrl } from "@/lib/services/file-processing-service"
import { canModifyRepository, getUserIdFromSession } from "./repository-permissions"

export interface RepositoryItem {
  id: number
  repositoryId: number
  type: 'document' | 'url' | 'text'
  name: string
  source: string
  metadata: Record<string, unknown>
  processingStatus: string
  processingError: string | null
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

// Sanitize filename to prevent directory traversal and other security issues
function sanitizeFilename(filename: string): string {
  // Remove any directory components and special characters
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace special chars with underscore
    .replace(/\.{2,}/g, '.') // Replace multiple dots with single dot
    .replace(/^\.+|\.+$/g, '') // Remove leading/trailing dots
    .slice(0, 255); // Limit length
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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Document upload denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }
    
    // Validate and sanitize inputs
    if (!input.name || input.name.trim().length === 0) {
      return { isSuccess: false, message: "Name is required" }
    }
    
    if (!input.file || !input.file.content) {
      return { isSuccess: false, message: "File content is required" }
    }
    
    // Sanitize the filename
    const sanitizedFilename = sanitizeFilename(input.file.fileName || input.name);

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)

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
    let fileContent: Buffer
    if (typeof input.file.content === 'string') {
      // It's a base64 string from the client
      fileContent = Buffer.from(input.file.content, 'base64')
    } else {
      // It's already a Buffer or Uint8Array
      fileContent = Buffer.from(input.file.content)
    }

    // Upload to S3
    log.info("Uploading document to S3", {
      fileName: sanitizedFilename,
      contentType: input.file.contentType,
      size: fileContent.length
    })
    
    const { key, url } = await uploadDocument({
      userId: userId.toString(),
      fileName: sanitizedFilename,
      fileContent,
      contentType: input.file.contentType,
      metadata: {
        repository_id: input.repository_id.toString(),
        type: 'repository_item'
      }
    })
    
    log.debug("Document uploaded to S3 successfully", { s3Key: key })

    // Create repository item
    log.info("Creating repository item in database", {
      repositoryId: input.repository_id,
      type: 'document',
      source: key
    })
    
    const result = await executeSQL<RepositoryItem>(
      `INSERT INTO repository_items (repository_id, type, name, source, metadata, processing_status)
       VALUES (:repository_id, 'document', :name, :source, :metadata::jsonb, 'pending')
       RETURNING *`,
      [
        { name: "repository_id", value: { longValue: input.repository_id } },
        { name: "name", value: { stringValue: input.name } },
        { name: "source", value: { stringValue: key } },
        { name: "metadata", value: { stringValue: JSON.stringify({
          contentType: input.file.contentType,
          size: input.file.size,
          s3_url: url,
          originalFileName: input.file.fileName
        }) } }
      ]
    )

    const item = result[0]

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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Presigned upload denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }
    
    // Validate inputs
    if (!input.name || input.name.trim().length === 0) {
      return { isSuccess: false, message: "Name is required" }
    }
    
    if (!input.s3Key || input.s3Key.trim().length === 0) {
      return { isSuccess: false, message: "S3 key is required" }
    }

    // Get the user ID from the cognito_sub
    const userId = await getUserIdFromSession(session.sub)

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

    // Create repository item with S3 key reference
    log.info("Creating repository item in database", {
      repositoryId: input.repository_id,
      type: 'document',
      s3Key: input.s3Key
    })
    
    const result = await executeSQL<RepositoryItem>(
      `INSERT INTO repository_items (repository_id, type, name, source, metadata, processing_status)
       VALUES (:repository_id, 'document', :name, :source, :metadata::jsonb, 'pending')
       RETURNING *`,
      [
        { name: "repository_id", value: { longValue: input.repository_id } },
        { name: "name", value: { stringValue: input.name } },
        { name: "source", value: { stringValue: input.s3Key } },
        { name: "metadata", value: { stringValue: JSON.stringify({
          contentType: input.metadata.contentType,
          size: input.metadata.size,
          originalFileName: input.metadata.originalFileName,
          uploadedAt: new Date().toISOString()
        }) } }
      ]
    )

    const item = result[0]

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
    const hasAccess = await hasToolAccess("knowledge-repositories")
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

    // Validate URL
    try {
      new URL(input.url)
    } catch {
      return { isSuccess: false, message: "Invalid URL" }
    }

    log.info("Creating URL repository item in database", {
      repositoryId: input.repository_id,
      type: 'url',
      url: input.url
    })
    
    const result = await executeSQL<RepositoryItem>(
      `INSERT INTO repository_items (repository_id, type, name, source, metadata, processing_status)
       VALUES (:repository_id, 'url', :name, :source, :metadata::jsonb, 'pending')
       RETURNING *`,
      [
        { name: "repository_id", value: { longValue: input.repository_id } },
        { name: "name", value: { stringValue: input.name } },
        { name: "source", value: { stringValue: input.url } },
        { name: "metadata", value: { stringValue: JSON.stringify({}) } }
      ]
    )

    const item = result[0]

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
    
    const endTimer = timer
    endTimer({ status: "success", itemId: item.id })
    
    revalidatePath(`/repositories/${input.repository_id}`)
    return createSuccess(item, "URL added successfully")
  } catch (error) {
    const endTimer = timer
    endTimer({ status: "error" })
    
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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Text addition denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.repository_id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)

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

    // Start a transaction to add both the item and its chunk
    log.info("Creating text item with transaction", {
      repositoryId: input.repository_id,
      contentLength: input.content.length
    })
    
    const transactionResults = await executeTransaction<{ id: number }>([
      {
        sql: `INSERT INTO repository_items (repository_id, type, name, source, metadata, processing_status)
              VALUES (:repository_id, 'text', :name, :source, :metadata::jsonb, 'completed')
              RETURNING id`,
        parameters: [
          { name: "repository_id", value: { longValue: input.repository_id } },
          { name: "name", value: { stringValue: input.name } },
          { name: "source", value: { stringValue: input.content } },
          { name: "metadata", value: { stringValue: JSON.stringify({
            length: input.content.length
          }) } }
        ]
      }
    ])

    const itemId = transactionResults[0][0].id
    log.debug("Text item created", { itemId })

    // Add the chunk in a second transaction call
    log.debug("Adding text chunk", { itemId, chunkIndex: 0 })
    await executeTransaction([
      {
        sql: `INSERT INTO repository_item_chunks (item_id, content, chunk_index, metadata)
              VALUES (:item_id, :content, 0, :metadata::jsonb)`,
        parameters: [
          { name: "item_id", value: { longValue: itemId } },
          { name: "content", value: { stringValue: input.content } },
          { name: "metadata", value: { stringValue: JSON.stringify({}) } }
        ]
      }
    ])

    // Fetch the created item
    log.debug("Fetching created text item", { itemId })
    const result = await executeSQL<RepositoryItem>(
      `SELECT * FROM repository_items WHERE id = :id`,
      [{ name: "id", value: { longValue: itemId } }]
    )

    log.info("Text added successfully", {
      itemId,
      repositoryId: input.repository_id
    })
    
    timer({ status: "success", itemId })
    
    revalidatePath(`/repositories/${input.repository_id}`)
    return createSuccess(result[0], "Text added successfully")
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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Item removal denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the user ID from the cognito_sub
    const userId = await getUserIdFromSession(session.sub)

    // Get the item to check if it's a document (need to delete from S3)
    const items = await executeSQL<RepositoryItem>(
      `SELECT * FROM repository_items WHERE id = :id`,
      [{ name: "id", value: { longValue: itemId } }]
    )

    if (items.length === 0) {
      return { isSuccess: false, message: "Item not found" }
    }

    const item = items[0]

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

    // Delete from S3 if it's a document
    if (item.type === 'document') {
      log.info("Deleting document from S3", {
        itemId,
        s3Key: item.source
      })
      
      try {
        await deleteDocument(item.source)
        log.info("Document deleted from S3 successfully")
      } catch (error) {
        // Log error but continue with database deletion
        log.error("Failed to delete from S3", {
          itemId,
          s3Key: item.source,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      }
    }

    // Delete from database (cascades to chunks)
    log.info("Deleting item from database", { itemId })
    await executeSQL(
      `DELETE FROM repository_items WHERE id = :id`,
      [{ name: "id", value: { longValue: itemId } }]
    )

    log.info("Repository item removed successfully", {
      itemId,
      repositoryId: item.repositoryId
    })
    
    timer({ status: "success", itemId })
    
    revalidatePath(`/repositories/${item.repositoryId}`)
    return createSuccess(undefined as any, "Item removed successfully")
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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("List items denied - insufficient permissions", {
        userId: session.sub,
        repositoryId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.debug("Fetching repository items from database", { repositoryId })
    const items = await executeSQL<RepositoryItem>(
      `SELECT * FROM repository_items 
       WHERE repository_id = :repository_id
       ORDER BY created_at DESC`,
      [{ name: "repository_id", value: { longValue: repositoryId } }]
    )

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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Search denied - insufficient permissions", {
        userId: session.sub,
        repositoryId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Search in item names
    log.debug("Searching item names", { repositoryId, query })
    const items = await executeSQL<RepositoryItem>(
      `SELECT * FROM repository_items 
       WHERE repository_id = :repository_id
       AND LOWER(name) LIKE LOWER(:query)
       ORDER BY created_at DESC`,
      [
        { name: "repository_id", value: { longValue: repositoryId } },
        { name: "query", value: { stringValue: `%${query}%` } }
      ]
    )

    // Search in chunk content
    log.debug("Searching chunk content", { repositoryId, query })
    const chunks = await executeSQL<RepositoryItemChunk & { itemName: string }>(
      `SELECT 
        c.*,
        i.name as item_name
       FROM repository_item_chunks c
       JOIN repository_items i ON c.item_id = i.id
       WHERE i.repository_id = :repository_id
       AND LOWER(c.content) LIKE LOWER(:query)
       ORDER BY c.item_id, c.chunk_index
       LIMIT 20`,
      [
        { name: "repository_id", value: { longValue: repositoryId } },
        { name: "query", value: { stringValue: `%${query}%` } }
      ]
    )

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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Get chunks denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.debug("Fetching chunks from database", { itemId })
    const chunks = await executeSQL<RepositoryItemChunk>(
      `SELECT * FROM repository_item_chunks 
       WHERE item_id = :item_id
       ORDER BY chunk_index`,
      [{ name: "item_id", value: { longValue: itemId } }]
    )

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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Status update denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.info("Updating processing status in database", {
      itemId,
      status,
      hasError: !!error
    })
    
    await executeSQL(
      `UPDATE repository_items 
       SET processing_status = :status, 
           processing_error = :error,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :id`,
      [
        { name: "id", value: { longValue: itemId } },
        { name: "status", value: { stringValue: status } },
        { name: "error", value: error ? { stringValue: error } : { isNull: true } }
      ]
    )

    log.info("Processing status updated successfully", { itemId, status })
    
    timer({ status: "success", itemId })
    
    return createSuccess(undefined as any, "Status updated successfully")
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
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Download URL denied - insufficient permissions", {
        userId: session.sub,
        itemId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the item to check if it's a document
    log.debug("Fetching item from database", { itemId })
    const items = await executeSQL<RepositoryItem>(
      `SELECT * FROM repository_items WHERE id = :id`,
      [{ name: "id", value: { longValue: itemId } }]
    )

    if (items.length === 0) {
      log.warn("Item not found for download URL", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    const item = items[0]

    if (item.type !== 'document') {
      log.warn("Download URL requested for non-document item", {
        itemId,
        itemType: item.type
      })
      return { isSuccess: false, message: "Item is not a document" }
    }

    // Generate a presigned URL for download
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
    
    const s3Client = new S3Client({})
    const bucketName = process.env.DOCUMENTS_BUCKET_NAME
    
    if (!bucketName) {
      return { isSuccess: false, message: "Storage not configured" }
    }

    // Extract file extension from the original S3 key or metadata
    let filename = item.name
    const metadata = item.metadata as any
    
    // Try to get extension from original filename or S3 key
    let extension = ''
    
    if (metadata?.originalFileName) {
      // Use the original filename's extension
      extension = metadata.originalFileName.split('.').pop() || ''
    } else {
      // Extract from S3 key
      const urlParts = item.source.split('/')
      const s3Filename = urlParts[urlParts.length - 1]
      extension = s3Filename.split('.').pop() || ''
    }
    
    // Add extension if not already present in the name
    if (extension && !filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
      filename = `${filename}.${extension}`
    }

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: item.source,
      ResponseContentDisposition: `attachment; filename="${filename}"`
    })

    log.info("Generating presigned download URL", {
      itemId,
      s3Key: item.source,
      fileName: filename
    })
    
    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }) // 1 hour

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