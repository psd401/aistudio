"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { type ActionState } from "@/types/actions-types"
import { hasRole } from "@/utils/roles"
import {
  getAllRepositoriesWithOwner,
  updateRepository,
  deleteRepository,
  getRepositoryItems,
  getRepositoryItemById,
  deleteRepositoryItem,
  isSystemManagedRepository
} from "@/lib/db/drizzle"
import { assertNotSystemManagedRepository } from "@/lib/repositories/repository-access-guard"
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
import type { Repository } from "@/actions/repositories/repository.actions"
import type { RepositoryItem } from "@/actions/repositories/repository-items.actions"
import { deleteRepositoryItemStorage } from "@/lib/repositories/content-platform/storage-cleanup"

export interface RepositoryWithOwner extends Repository {
  ownerEmail: string | null
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
    // Exclude system-managed repositories (the Atrium retrieval index, #1056):
    // their content is governed by per-object `canView`, so they must not be
    // browsable / editable through the generic repository admin UI.
    const repositoriesRaw = (await getAllRepositoriesWithOwner()).filter(
      repo => !isSystemManagedRepository(repo)
    )

    // Convert to expected type
    const repositories: RepositoryWithOwner[] = repositoriesRaw.map(repo => ({
      id: repo.id,
      name: repo.name,
      description: repo.description,
      ownerId: repo.ownerId,
      isPublic: repo.isPublic ?? false,
      metadata: repo.metadata ?? {},
      createdAt: repo.createdAt ?? new Date(),
      updatedAt: repo.updatedAt ?? new Date(),
      ownerEmail: repo.ownerEmail,
      itemCount: repo.itemCount
    }))

    log.info("All repositories fetched successfully", {
      repositoryCount: repositories.length
    })

    timer({ status: "success", count: repositories.length })

    return createSuccess(repositories, "Repositories loaded successfully")
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

    // Check if any fields provided
    const hasUpdates =
      input.name !== undefined ||
      input.description !== undefined ||
      input.isPublic !== undefined ||
      input.metadata !== undefined

    if (!hasUpdates) {
      log.warn("No fields provided for update")
      return { isSuccess: false, message: "No fields to update" }
    }

    // A system-managed repository (the Atrium retrieval index, #1056) is
    // immutable through this generic admin path: editing it (e.g. flipping
    // `isPublic` to true, or stripping the `systemManaged` flag) would reopen the
    // shared-index bypass the system-managed guards close.
    await assertNotSystemManagedRepository(input.id)

    log.info("Updating repository in database (admin)", {
      repositoryId: input.id
    })

    // Build update data object with only provided fields
    const updateData: {
      name?: string;
      description?: string | null;
      isPublic?: boolean;
      metadata?: Record<string, unknown> | null;
    } = {}

    if (input.name !== undefined) updateData.name = input.name
    if (input.description !== undefined) updateData.description = input.description ?? null
    if (input.isPublic !== undefined) updateData.isPublic = input.isPublic
    if (input.metadata !== undefined) updateData.metadata = input.metadata

    const resultRaw = await updateRepository(input.id, updateData)

    if (!resultRaw) {
      log.error("Repository not found for update", { repositoryId: input.id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", input.id)
    }

    // Convert to expected type
    const result: Repository = {
      id: resultRaw.id,
      name: resultRaw.name,
      description: resultRaw.description,
      ownerId: resultRaw.ownerId,
      isPublic: resultRaw.isPublic ?? false,
      metadata: resultRaw.metadata ?? {},
      createdAt: resultRaw.createdAt ?? new Date(),
      updatedAt: resultRaw.updatedAt ?? new Date()
    }

    log.info("Repository updated successfully (admin)", {
      repositoryId: result.id,
      name: result.name
    })

    timer({ status: "success", repositoryId: result.id })

    revalidatePath("/admin/repositories")
    revalidatePath(`/repositories/${input.id}`)
    return createSuccess(result, "Repository updated successfully (admin)")
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

    // Never delete a system-managed repo (the Atrium index, #1056) through the
    // generic admin path — it would destroy the retrieval index out-of-band.
    await assertNotSystemManagedRepository(id)

    // First, get all stored items so source and canonical artifacts are removed.
    log.debug("Fetching stored repository items for S3 deletion")
    const items = await getRepositoryItems(id)

    const storedItems = items.filter(
      item => item.type === 'document' || item.type === 'image'
    )

    log.info("Found repository item objects to delete from S3", {
      itemCount: storedItems.length,
      repositoryId: id
    })

    if (storedItems.length > 0) {
      log.info("Deleting repository item objects from S3", {
        count: storedItems.length,
      })
      const deletePromises = storedItems.map(item =>
        deleteRepositoryItemStorage(item).catch(error => {
          // Log error but continue with deletion
          log.error("Failed to delete repository item objects from S3", {
            file: item.source,
            itemId: item.id,
            error: error instanceof Error ? error.message : "Unknown error"
          })
        })
      )
      await Promise.all(deletePromises)
      log.info("S3 repository item cleanup completed")
    }

    // Now delete the repository (this will cascade delete all items and chunks)
    log.info("Deleting repository from database (admin)", { repositoryId: id })
    const deletedCount = await deleteRepository(id)

    if (deletedCount === 0) {
      log.warn("Repository not found for deletion", { repositoryId: id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", id)
    }

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

    // System-managed repositories (the Atrium retrieval index, #1056) are not
    // browsable through the generic admin UI — their per-object visibility is
    // enforced by `retrievalService`, not repository-level access.
    await assertNotSystemManagedRepository(repositoryId)

    log.debug("Fetching repository items from database (admin)", { repositoryId })
    const itemsRaw = await getRepositoryItems(repositoryId)

    // Convert to expected type
    const items: RepositoryItem[] = itemsRaw.map(item => ({
      id: item.id,
      repositoryId: item.repositoryId,
      type: item.type as 'document' | 'url' | 'text',
      name: item.name,
      source: item.source,
      metadata: item.metadata ?? {},
      processingStatus: item.processingStatus ?? 'pending',
      processingError: item.processingError,
      createdAt: item.createdAt ?? new Date(),
      updatedAt: item.updatedAt ?? new Date()
    }))

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
    const item = await getRepositoryItemById(itemId)

    if (!item) {
      log.warn("Item not found for removal", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

    // Never mutate a system-managed repo's items (the Atrium index, #1056) —
    // deleting one out-of-band would desync the retrieval index.
    await assertNotSystemManagedRepository(item.repositoryId)

    log.debug("Item found", {
      itemId,
      itemType: item.type,
      repositoryId: item.repositoryId
    })

    // Delete stored source and canonical derivatives before cascading DB rows.
    if (item.type === 'document' || item.type === 'image') {
      log.info("Deleting repository item objects from S3 (admin)", {
        itemId,
        s3Key: item.source
      })

      try {
        const cleanup = await deleteRepositoryItemStorage(item)
        log.info("Repository item objects deleted from S3 successfully", cleanup)
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
    const deletedCount = await deleteRepositoryItem(itemId)

    if (deletedCount === 0) {
      log.warn("Item not found for deletion", { itemId })
      throw ErrorFactories.dbRecordNotFound("repository_items", itemId)
    }

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
