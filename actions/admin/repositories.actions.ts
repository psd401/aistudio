"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { type ActionState } from "@/types/actions-types"
import { hasRole } from "@/utils/roles"
import type { SqlParameter } from "@aws-sdk/client-rds-data"
import {
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { revalidatePath } from "next/cache"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
import type { Repository } from "@/actions/repositories/repository.actions"
import type { RepositoryItem } from "@/actions/repositories/repository-items.actions"

export interface RepositoryWithOwner extends Repository {
  ownerEmail: string
}

/**
 * Helper to ensure session exists and user is administrator
 * Throws error if authorization fails
 */
async function requireAdminSession(log?: ReturnType<typeof createLogger>) {
  const session = await getServerSession()
  if (!session) {
    log?.warn("Unauthorized admin access attempt")
    throw ErrorFactories.authNoSession()
  }

  log?.debug("Checking administrator role", { userId: session.sub })
  const isAdmin = await hasRole("administrator")
  if (!isAdmin) {
    log?.warn("Admin access denied - insufficient privileges", {
      userId: session.sub
    })
    throw ErrorFactories.authzAdminRequired()
  }

  log?.debug("Admin access granted", { userId: session.sub })
  return session
}

/**
 * Admin function to list all repositories with owner information
 */
export async function listAllRepositories(): Promise<ActionState<RepositoryWithOwner[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.listAllRepositories")
  const log = createLogger({ requestId, action: "admin.listAllRepositories" })
  
  try {
    log.info("Admin action started: Listing all repositories")
    
    await requireAdminSession(log)

    log.debug("Fetching all repositories from database")
    const repositories = await executeSQL<RepositoryWithOwner>(
      `SELECT 
        kr.*,
        u.email as owner_email,
        (SELECT COUNT(*) FROM repository_items WHERE repository_id = kr.id) as item_count
       FROM knowledge_repositories kr
       LEFT JOIN users u ON kr.owner_id = u.id
       ORDER BY kr.created_at DESC`
    )

    log.info("All repositories fetched successfully", {
      repositoryCount: repositories.length
    })
    
    const transformed = repositories.map(repo => transformSnakeToCamel<RepositoryWithOwner>(repo))
    
    timer({ status: "success", count: repositories.length })
    
    return createSuccess(transformed, "Repositories loaded successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to list repositories. Please try again or contact support.", {
      context: "admin.listAllRepositories",
      requestId,
      operation: "admin.listAllRepositories"
    })
  }
}

/**
 * Admin function to update any repository
 */
export async function adminUpdateRepository(
  input: {
    id: number
    name?: string
    description?: string
    isPublic?: boolean
    metadata?: Record<string, unknown>
  }
): Promise<ActionState<Repository>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.updateRepository")
  const log = createLogger({ requestId, action: "admin.updateRepository" })
  
  try {
    log.info("Admin action started: Updating repository", {
      repositoryId: input.id,
      updates: sanitizeForLogging(input)
    })
    
    await requireAdminSession(log)

    const updates: string[] = []
    const params: SqlParameter[] = [
      { name: "id", value: { longValue: input.id } }
    ]

    if (input.name !== undefined) {
      updates.push("name = :name")
      params.push({ name: "name", value: { stringValue: input.name } })
    }

    if (input.description !== undefined) {
      updates.push("description = :description")
      params.push({ name: "description", value: input.description ? { stringValue: input.description } : { isNull: true } })
    }

    if (input.isPublic !== undefined) {
      updates.push("is_public = :is_public")
      params.push({ name: "is_public", value: { booleanValue: input.isPublic } })
    }

    if (input.metadata !== undefined) {
      updates.push("metadata = :metadata::jsonb")
      params.push({ name: "metadata", value: { stringValue: JSON.stringify(input.metadata) } })
    }

    if (updates.length === 0) {
      log.warn("No fields provided for update")
      return { isSuccess: false, message: "No fields to update" }
    }

    updates.push("updated_at = CURRENT_TIMESTAMP")

    log.info("Updating repository in database (admin)", {
      repositoryId: input.id,
      fieldsUpdated: updates.length - 1
    })
    
    const result = await executeSQL<Repository>(
      `UPDATE knowledge_repositories 
       SET ${updates.join(", ")}
       WHERE id = :id
       RETURNING *`,
      params
    )

    if (result.length === 0) {
      log.error("Repository not found for update", { repositoryId: input.id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", input.id)
    }

    log.info("Repository updated successfully (admin)", {
      repositoryId: result[0].id,
      name: result[0].name
    })
    
    timer({ status: "success", repositoryId: result[0].id })
    
    revalidatePath("/admin/repositories")
    revalidatePath(`/repositories/${input.id}`)
    return createSuccess(transformSnakeToCamel<Repository>(result[0]), "Repository updated successfully (admin)")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to update repository. Please try again or contact support.", {
      context: "admin.updateRepository",
      requestId,
      operation: "admin.updateRepository",
      metadata: { repositoryId: input.id }
    })
  }
}

/**
 * Admin function to delete any repository
 */
export async function adminDeleteRepository(
  id: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.deleteRepository")
  const log = createLogger({ requestId, action: "admin.deleteRepository" })
  
  try {
    log.info("Admin action started: Deleting repository", { repositoryId: id })
    
    await requireAdminSession(log)

    // First, get all document items to delete from S3
    log.debug("Fetching document items for S3 deletion")
    const items = await executeSQL<{ id: number; type: string; source: string }>(
      `SELECT id, type, source FROM repository_items 
       WHERE repository_id = :repository_id AND type = 'document'`,
      [{ name: "repository_id", value: { longValue: id } }]
    )
    
    log.info("Found documents to delete from S3", {
      documentCount: items.length,
      repositoryId: id
    })

    // Delete all documents from S3 in parallel
    if (items.length > 0) {
      const { deleteDocument } = await import("@/lib/aws/s3-client")
      
      log.info("Deleting documents from S3", { count: items.length })
      const deletePromises = items.map(item =>
        deleteDocument(item.source).catch(error => {
          // Log error but continue with deletion
          log.error("Failed to delete S3 file", {
            file: item.source,
            itemId: item.id,
            error: error instanceof Error ? error.message : "Unknown error"
          })
        })
      )
      await Promise.all(deletePromises)
      log.info("S3 document cleanup completed")
    }

    // Now delete the repository (this will cascade delete all items and chunks)
    log.info("Deleting repository from database (admin)", { repositoryId: id })
    await executeSQL(
      `DELETE FROM knowledge_repositories WHERE id = :id`,
      [{ name: "id", value: { longValue: id } }]
    )

    log.info("Repository deleted successfully (admin)", { repositoryId: id })
    
    timer({ status: "success", repositoryId: id })
    
    revalidatePath("/admin/repositories")
    revalidatePath("/repositories")
    return createSuccess(undefined, "Repository deleted successfully (admin)")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to delete repository. Please try again or contact support.", {
      context: "admin.deleteRepository",
      requestId,
      operation: "admin.deleteRepository",
      metadata: { repositoryId: id }
    })
  }
}

/**
 * Admin function to get repository items
 */
export async function adminGetRepositoryItems(
  repositoryId: number
): Promise<ActionState<RepositoryItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.getRepositoryItems")
  const log = createLogger({ requestId, action: "admin.getRepositoryItems" })
  
  try {
    log.info("Admin action started: Getting repository items", { repositoryId })
    
    await requireAdminSession(log)

    log.debug("Fetching repository items from database (admin)", { repositoryId })
    const items = await executeSQL<RepositoryItem>(
      `SELECT * FROM repository_items 
       WHERE repository_id = :repository_id
       ORDER BY created_at DESC`,
      [{ name: "repository_id", value: { longValue: repositoryId } }]
    )

    log.info("Repository items fetched successfully (admin)", {
      repositoryId,
      itemCount: items.length
    })
    
    timer({ status: "success", count: items.length })
    
    return createSuccess(items, "Items loaded successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to list repository items. Please try again or contact support.", {
      context: "admin.getRepositoryItems",
      requestId,
      operation: "admin.getRepositoryItems",
      metadata: { repositoryId }
    })
  }
}

/**
 * Admin function to remove an item from any repository
 */
export async function adminRemoveRepositoryItem(
  itemId: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("admin.removeRepositoryItem")
  const log = createLogger({ requestId, action: "admin.removeRepositoryItem" })
  
  try {
    log.info("Admin action started: Removing repository item", { itemId })
    
    await requireAdminSession(log)

    // Get the item to check if it's a document (need to delete from S3)
    log.debug("Fetching item details", { itemId })
    const items = await executeSQL<{ id: number; type: string; source: string; repositoryId: number }>(
      `SELECT * FROM repository_items WHERE id = :id`,
      [{ name: "id", value: { longValue: itemId } }]
    )

    if (items.length === 0) {
      log.warn("Item not found for removal", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    const item = items[0]
    log.debug("Item found", { 
      itemId,
      itemType: item.type,
      repositoryId: item.repositoryId
    })

    // Delete from S3 if it's a document
    if (item.type === 'document') {
      log.info("Deleting document from S3 (admin)", {
        itemId,
        s3Key: item.source
      })
      
      try {
        const { deleteDocument } = await import("@/lib/aws/s3-client")
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
    log.info("Deleting item from database (admin)", { itemId })
    await executeSQL(
      `DELETE FROM repository_items WHERE id = :id`,
      [{ name: "id", value: { longValue: itemId } }]
    )

    log.info("Repository item removed successfully (admin)", {
      itemId,
      repositoryId: item.repositoryId
    })
    
    timer({ status: "success", itemId })
    
    revalidatePath(`/admin/repositories`)
    revalidatePath(`/repositories/${item.repositoryId}`)
    return createSuccess(undefined, "Item removed successfully (admin)")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to remove item. Please try again or contact support.", {
      context: "admin.removeRepositoryItem",
      requestId,
      operation: "admin.removeRepositoryItem",
      metadata: { itemId }
    })
  }
}