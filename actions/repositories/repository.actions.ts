"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { type ActionState } from "@/types/actions-types"
import { hasToolAccess } from "@/utils/roles"
import {
  createRepository as drizzleCreateRepository,
  updateRepository as drizzleUpdateRepository,
  deleteRepository as drizzleDeleteRepository,
  getRepositoryById,
  getRepositoriesByOwnerId,
  getRepositoryItems,
  getRepositoryAccessList,
  grantUserAccess,
  grantRoleAccess,
  revokeAccessById,
  getUserAccessibleRepositories
} from "@/lib/db/drizzle"
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
import { canModifyRepository, getUserIdFromSession } from "./repository-permissions"

export interface Repository {
  id: number
  name: string
  description: string | null
  ownerId: number
  isPublic: boolean
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  ownerName?: string
  itemCount?: number
}

export interface CreateRepositoryInput {
  name: string
  description?: string
  isPublic?: boolean
  metadata?: Record<string, unknown>
}

export interface UpdateRepositoryInput {
  id: number
  name?: string
  description?: string
  isPublic?: boolean
  metadata?: Record<string, unknown>
}


export async function createRepository(
  input: CreateRepositoryInput
): Promise<ActionState<Repository>> {
  const requestId = generateRequestId()
  const timer = startTimer("createRepository")
  const log = createLogger({ requestId, action: "createRepository" })
  
  try {
    log.info("Action started: Creating repository", { 
      input: sanitizeForLogging(input) 
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized repository creation attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository creation denied - insufficient permissions", {
        userId: session.sub
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)
    log.debug("User ID retrieved", { userId })

    log.info("Creating repository in database", {
      name: input.name,
      isPublic: input.isPublic || false,
      ownerId: userId
    })

    const resultRaw = await drizzleCreateRepository({
      name: input.name,
      description: input.description ?? null,
      ownerId: userId,
      isPublic: input.isPublic ?? false,
      metadata: input.metadata ?? null
    })

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

    log.info("Repository created successfully", {
      repositoryId: result.id,
      name: result.name
    })

    timer({ status: "success", repositoryId: result.id })

    revalidatePath("/repositories")
    return createSuccess(result, "Repository created successfully")
  } catch (error) {
    
    timer({ status: "error" })
    
    return handleError(error, "Failed to create repository. Please try again or contact support.", {
      context: "createRepository",
      requestId,
      operation: "createRepository"
    })
  }
}

export async function updateRepository(
  input: UpdateRepositoryInput
): Promise<ActionState<Repository>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateRepository")
  const log = createLogger({ requestId, action: "updateRepository" })
  
  try {
    log.info("Action started: Updating repository", { 
      repositoryId: input.id,
      updates: sanitizeForLogging(input) 
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized repository update attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository update denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: input.id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: input.id, userId })
    const canModify = await canModifyRepository(input.id, userId)
    if (!canModify) {
      log.warn("Repository update denied - not owner", {
        userId,
        repositoryId: input.id
      })
      throw ErrorFactories.authzOwnerRequired("modify repository")
    }

    // Check if any fields provided
    const hasUpdates =
      input.name !== undefined ||
      input.description !== undefined ||
      input.isPublic !== undefined ||
      input.metadata !== undefined

    if (!hasUpdates) {
      log.warn("No fields provided for update")
      return createSuccess(null as unknown as Repository, "No changes to apply")
    }

    log.info("Updating repository in database", {
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

    const resultRaw = await drizzleUpdateRepository(input.id, updateData)

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

    log.info("Repository updated successfully", {
      repositoryId: result.id,
      name: result.name
    })

    timer({ status: "success", repositoryId: result.id })

    revalidatePath("/repositories")
    revalidatePath(`/repositories/${input.id}`)
    return createSuccess(result, "Repository updated successfully")
  } catch (error) {
    
    timer({ status: "error" })
    
    return handleError(error, "Failed to update repository. Please try again or contact support.", {
      context: "updateRepository",
      requestId,
      operation: "updateRepository",
      metadata: { repositoryId: input.id }
    })
  }
}

export async function deleteRepository(
  id: number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteRepository")
  const log = createLogger({ requestId, action: "deleteRepository" })
  
  try {
    log.info("Action started: Deleting repository", { repositoryId: id })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized repository deletion attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository deletion denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Get the user ID from the cognito_sub
    log.debug("Getting user ID from session")
    const userId = await getUserIdFromSession(session.sub)

    // Check if user can modify this repository
    log.debug("Checking repository ownership", { repositoryId: id, userId })
    const canModify = await canModifyRepository(id, userId)
    if (!canModify) {
      log.warn("Repository deletion denied - not owner", {
        userId,
        repositoryId: id
      })
      throw ErrorFactories.authzOwnerRequired("delete repository")
    }

    // First, get all document items to delete from S3
    log.debug("Fetching document items for deletion")
    const items = await getRepositoryItems(id)

    // Filter for document types
    const documents = items.filter(item => item.type === 'document')

    log.info("Found documents to delete from S3", {
      documentCount: documents.length,
      repositoryId: id
    })

    // Delete all documents from S3 in parallel
    if (documents.length > 0) {
      const { deleteDocument } = await import("@/lib/aws/s3-client")

      const deletePromises = documents.map(item =>
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
    log.info("Deleting repository from database", { repositoryId: id })
    const deletedCount = await drizzleDeleteRepository(id)

    if (deletedCount === 0) {
      log.warn("Repository not found for deletion", { repositoryId: id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", id)
    }

    log.info("Repository deleted successfully", { repositoryId: id })
    
    
    timer({ status: "success", repositoryId: id })

    revalidatePath("/repositories")
    return createSuccess(undefined as void, "Repository deleted successfully")
  } catch (error) {
    
    timer({ status: "error" })
    
    return handleError(error, "Failed to delete repository. Please try again or contact support.", {
      context: "deleteRepository",
      requestId,
      operation: "deleteRepository",
      metadata: { repositoryId: id }
    })
  }
}

export async function listRepositories(): Promise<ActionState<Repository[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("listRepositories")
  const log = createLogger({ requestId, action: "listRepositories" })
  
  try {
    log.info("Action started: Listing repositories")
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized repository list attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository list denied - insufficient permissions", {
        userId: session.sub
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.debug("Fetching repositories from database")
    const userId = await getUserIdFromSession(session.sub)
    const repositoriesRaw = await getRepositoriesByOwnerId(userId)

    // Get item counts for each repository
    const repositories: Repository[] = await Promise.all(
      repositoriesRaw.map(async (repo) => {
        const items = await getRepositoryItems(repo.id)
        return {
          id: repo.id,
          name: repo.name,
          description: repo.description,
          ownerId: repo.ownerId,
          isPublic: repo.isPublic ?? false,
          metadata: repo.metadata ?? {},
          createdAt: repo.createdAt ?? new Date(),
          updatedAt: repo.updatedAt ?? new Date(),
          itemCount: items.length
        }
      })
    )

    log.info("Repositories fetched successfully", {
      repositoryCount: repositories.length
    })

    timer({ status: "success", count: repositories.length })

    return createSuccess(repositories, "Repositories loaded successfully")
  } catch (error) {
    
    timer({ status: "error" })
    
    return handleError(error, "Failed to list repositories. Please try again or contact support.", {
      context: "listRepositories",
      requestId,
      operation: "listRepositories"
    })
  }
}

export async function getRepository(
  id: number
): Promise<ActionState<Repository>> {
  const requestId = generateRequestId()
  const timer = startTimer("getRepository")
  const log = createLogger({ requestId, action: "getRepository" })
  
  try {
    log.info("Action started: Getting repository", { repositoryId: id })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized repository access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository access denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.debug("Fetching repository from database", { repositoryId: id })
    const resultRaw = await getRepositoryById(id)

    if (!resultRaw) {
      log.warn("Repository not found", { repositoryId: id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", id)
    }

    // Get item count
    const items = await getRepositoryItems(id)

    const result: Repository = {
      id: resultRaw.id,
      name: resultRaw.name,
      description: resultRaw.description,
      ownerId: resultRaw.ownerId,
      isPublic: resultRaw.isPublic ?? false,
      metadata: resultRaw.metadata ?? {},
      createdAt: resultRaw.createdAt ?? new Date(),
      updatedAt: resultRaw.updatedAt ?? new Date(),
      itemCount: items.length
    }

    log.info("Repository fetched successfully", {
      repositoryId: result.id,
      name: result.name
    })

    timer({ status: "success", repositoryId: id })

    return createSuccess(result, "Repository loaded successfully")
  } catch (error) {
    
    timer({ status: "error" })
    
    return handleError(error, "Failed to get repository. Please try again or contact support.", {
      context: "getRepository",
      requestId,
      operation: "getRepository",
      metadata: { repositoryId: id }
    })
  }
}

export async function getRepositoryAccess(
  repositoryId: number
): Promise<ActionState<Record<string, unknown>[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getRepositoryAccess")
  const log = createLogger({ requestId, action: "getRepositoryAccess" })
  
  try {
    log.info("Action started: Getting repository access list", { repositoryId })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized repository access list attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("Checking repository access permissions")
    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository access list denied - insufficient permissions", {
        userId: session.sub,
        repositoryId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.debug("Fetching repository access list from database", { repositoryId })
    const access = await getRepositoryAccessList(repositoryId)

    log.info("Repository access list fetched successfully", {
      repositoryId,
      accessCount: access.length
    })

    timer({ status: "success", count: access.length })

    return createSuccess(access as Record<string, unknown>[], "Access list loaded successfully")
  } catch (error) {
    
    timer({ status: "error" })
    
    return handleError(error, "Failed to get repository access. Please try again or contact support.", {
      context: "getRepositoryAccess",
      requestId,
      operation: "getRepositoryAccess",
      metadata: { repositoryId }
    })
  }
}

export async function grantRepositoryAccess(
  repositoryId: number,
  userId: number | null,
  roleId: number | null
): Promise<ActionState<void>> {
  try {
    const session = await getServerSession()
    if (!session) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    if (!userId && !roleId) {
      return { isSuccess: false, message: "Must specify either user or role" }
    }

    if (userId) {
      await grantUserAccess(repositoryId, userId)
    } else if (roleId) {
      await grantRoleAccess(repositoryId, roleId)
    }

    revalidatePath(`/repositories/${repositoryId}`)
    return createSuccess(undefined as void, "Access granted successfully")
  } catch (error) {
    return handleError(error, "Failed to grant repository access")
  }
}

export async function revokeRepositoryAccess(
  accessId: number
): Promise<ActionState<void>> {
  try {
    const session = await getServerSession()
    if (!session) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    const deletedCount = await revokeAccessById(accessId)

    if (deletedCount === 0) {
      return { isSuccess: false, message: "Access record not found" }
    }

    return createSuccess(undefined as void, "Access revoked successfully")
  } catch (error) {
    return handleError(error, "Failed to revoke repository access")
  }
}

export async function getUserAccessibleRepositoriesAction(): Promise<ActionState<Array<{
  id: number
  name: string
  description: string | null
  isPublic: boolean
  itemCount: number
  lastUpdated: Date | null
}>>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserAccessibleRepositories")
  const log = createLogger({ requestId, action: "getUserAccessibleRepositories" })

  try {
    log.info("Action started: Getting user accessible repositories")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized")
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Access denied - missing knowledge-repositories tool access")
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    log.debug("Fetching accessible repositories via Drizzle", { cognitoSub: session.sub })

    // Get accessible repositories via Drizzle
    const repositoriesRaw = await getUserAccessibleRepositories(session.sub)

    // Convert nullable types to match return type
    const repositories = repositoriesRaw.map(repo => ({
      id: repo.id,
      name: repo.name,
      description: repo.description,
      isPublic: repo.isPublic ?? false,
      itemCount: repo.itemCount,
      lastUpdated: repo.lastUpdated
    }))

    log.info("Accessible repositories fetched successfully", {
      repositoryCount: repositories.length
    })

    timer({ status: "success", count: repositories.length })

    return createSuccess(repositories, "Repositories loaded successfully")
  } catch (error) {
    timer({ status: "error" })

    return handleError(error, "Failed to load accessible repositories", {
      context: "getUserAccessibleRepositories",
      requestId,
      operation: "getUserAccessibleRepositories"
    })
  }
}