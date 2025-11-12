"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { executeSQL } from "@/lib/db/data-api-adapter"
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
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
import { revalidatePath } from "next/cache"
import { transformSnakeToCamel } from "@/lib/db/field-mapper"
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
    
    const result = await executeSQL<Repository>(
      `INSERT INTO knowledge_repositories (name, description, owner_id, is_public, metadata)
       VALUES (:name, :description, :owner_id, :is_public, :metadata::jsonb)
       RETURNING *`,
      [
        { name: "name", value: { stringValue: input.name } },
        { name: "description", value: input.description ? { stringValue: input.description } : { isNull: true } },
        { name: "owner_id", value: { longValue: userId } },
        { name: "is_public", value: { booleanValue: input.isPublic || false } },
        { name: "metadata", value: { stringValue: JSON.stringify(input.metadata || {}) } }
      ]
    )

    log.info("Repository created successfully", {
      repositoryId: result[0].id,
      name: result[0].name
    })
    
    
    timer({ status: "success", repositoryId: result[0].id })
    
    revalidatePath("/repositories")
    return createSuccess(result[0], "Repository created successfully")
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

    const updates: string[] = []
    const params: any[] = [
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
      return createSuccess(null as unknown as Repository, "No changes to apply")
    }

    updates.push("updated_at = CURRENT_TIMESTAMP")

    log.info("Updating repository in database", {
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

    log.info("Repository updated successfully", {
      repositoryId: result[0].id,
      name: result[0].name
    })
    
    
    timer({ status: "success", repositoryId: result[0].id })
    
    revalidatePath("/repositories")
    revalidatePath(`/repositories/${input.id}`)
    return createSuccess(result[0], "Repository updated successfully")
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
    log.info("Deleting repository from database", { repositoryId: id })
    await executeSQL(
      `DELETE FROM knowledge_repositories WHERE id = :id`,
      [{ name: "id", value: { longValue: id } }]
    )

    log.info("Repository deleted successfully", { repositoryId: id })
    
    
    timer({ status: "success", repositoryId: id })
    
    revalidatePath("/repositories")
    return createSuccess(undefined as any, "Repository deleted successfully")
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
    const repositories = await executeSQL<Repository>(
      `SELECT 
        r.*,
        CONCAT(u.first_name, ' ', u.last_name) as owner_name,
        COUNT(DISTINCT ri.id) as item_count
       FROM knowledge_repositories r
       LEFT JOIN users u ON r.owner_id = u.id
       LEFT JOIN repository_items ri ON r.id = ri.repository_id
       GROUP BY r.id, u.first_name, u.last_name
       ORDER BY r.created_at DESC`
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
    const result = await executeSQL<Repository>(
      `SELECT 
        r.*,
        CONCAT(u.first_name, ' ', u.last_name) as owner_name,
        COUNT(DISTINCT ri.id) as item_count
       FROM knowledge_repositories r
       LEFT JOIN users u ON r.owner_id = u.id
       LEFT JOIN repository_items ri ON r.id = ri.repository_id
       WHERE r.id = :id
       GROUP BY r.id, r.name, r.description, r.owner_id, r.is_public, r.metadata, r.created_at, r.updated_at, u.first_name, u.last_name`,
      [{ name: "id", value: { longValue: id } }]
    )

    if (result.length === 0) {
      log.warn("Repository not found", { repositoryId: id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", id)
    }

    log.info("Repository fetched successfully", {
      repositoryId: result[0].id,
      name: result[0].name
    })
    
    
    timer({ status: "success", repositoryId: id })
    
    return createSuccess(result[0], "Repository loaded successfully")
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
): Promise<ActionState<any[]>> {
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
    const access = await executeSQL(
      `SELECT 
        ra.*,
        CONCAT(u.first_name, ' ', u.last_name) as user_name,
        r.name as role_name
       FROM repository_access ra
       LEFT JOIN users u ON ra.user_id = u.id
       LEFT JOIN roles r ON ra.role_id = r.id
       WHERE ra.repository_id = :repository_id
       ORDER BY ra.created_at DESC`,
      [{ name: "repository_id", value: { longValue: repositoryId } }]
    )

    log.info("Repository access list fetched successfully", {
      repositoryId,
      accessCount: access.length
    })
    
    
    timer({ status: "success", count: access.length })
    
    return createSuccess(access, "Access list loaded successfully")
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
  roleId: number | null,
  accessLevel: 'read' | 'write' | 'admin'
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

    await executeSQL(
      `INSERT INTO repository_access (repository_id, user_id, role_id, access_level)
       VALUES (:repository_id, :user_id, :role_id, :access_level)
       ON CONFLICT DO NOTHING`,
      [
        { name: "repository_id", value: { longValue: repositoryId } },
        { name: "user_id", value: userId ? { longValue: userId } : { isNull: true } },
        { name: "role_id", value: roleId ? { longValue: roleId } : { isNull: true } },
        { name: "access_level", value: { stringValue: accessLevel } }
      ]
    )

    revalidatePath(`/repositories/${repositoryId}`)
    return { isSuccess: true, message: "Access granted successfully", data: undefined as any }
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

    await executeSQL(
      `DELETE FROM repository_access WHERE id = :id`,
      [{ name: "id", value: { longValue: accessId } }]
    )

    return { isSuccess: true, message: "Access revoked successfully", data: undefined as any }
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
  try {
    const session = await getServerSession()
    if (!session) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasToolAccess("knowledge-repositories")
    if (!hasAccess) {
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    // Get the user ID from the cognito_sub
    const userResult = await executeSQL<{ id: number }>(
      `SELECT id FROM users WHERE cognito_sub = :cognitoSub`,
      [{ name: 'cognitoSub', value: { stringValue: session.sub } }]
    )
    
    if (!userResult || userResult.length === 0) {
      return { isSuccess: false, message: "User not found" }
    }
    
    const userId = userResult[0].id

    // Get repositories the user has access to
    const repositories = await executeSQL<any>(
      `WITH accessible_repos AS (
        SELECT DISTINCT r.id, r.name, r.description, r.is_public
        FROM knowledge_repositories r
        WHERE 
          r.is_public = true
          OR r.owner_id = :userId
          OR EXISTS (
            SELECT 1 FROM repository_access ra
            WHERE ra.repository_id = r.id AND ra.user_id = :userId
          )
          OR EXISTS (
            SELECT 1 FROM repository_access ra
            JOIN user_roles ur ON ur.role_id = ra.role_id
            WHERE ra.repository_id = r.id AND ur.user_id = :userId
          )
      )
      SELECT 
        ar.id,
        ar.name,
        ar.description,
        ar.is_public,
        COALESCE(COUNT(ri.id), 0) as item_count,
        MAX(ri.updated_at) as last_updated
      FROM accessible_repos ar
      LEFT JOIN repository_items ri ON ar.id = ri.repository_id
      GROUP BY ar.id, ar.name, ar.description, ar.is_public
      ORDER BY ar.name ASC`,
      [{ name: 'userId', value: { longValue: userId } }]
    )

    // Transform snake_case to camelCase using the standard field mapper
    const transformedRepos = repositories.map(repo => {
      const transformed = transformSnakeToCamel<{
        id: number
        name: string
        description: string | null
        isPublic: boolean
        itemCount: number
        lastUpdated: Date | null
      }>(repo)
      
      // Ensure itemCount is a number
      return {
        ...transformed,
        itemCount: Number(transformed.itemCount) || 0
      }
    })

    return { 
      isSuccess: true, 
      message: "Repositories loaded successfully", 
      data: transformedRepos 
    }
  } catch (error) {
    return handleError(error, "Failed to load accessible repositories")
  }
}