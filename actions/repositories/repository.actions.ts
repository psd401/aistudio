"use server"

import { getServerSession } from "@/lib/auth/server-session"
import { type ActionState } from "@/types/actions-types"
import { hasCapabilityAccess, hasRole } from "@/utils/roles"
import { getUserIdFromSession, canModifyRepository } from "@/actions/repositories/repository-permissions"
import {
  createRepository as drizzleCreateRepository,
  updateRepository as drizzleUpdateRepository,
  getRepositoryById,
  getRepositoryAccessList,
  grantUserAccess,
  grantRoleAccess,
  revokeAccessById,
  getUserAccessibleRepositories
} from "@/lib/db/drizzle"
import {
  assertNotSystemManagedRepository,
  assertRepositoryReadAccess,
  assertUserManagedDurableRepositoryForDeletion
} from "@/lib/repositories/repository-access-guard"
import { executeQuery } from "@/lib/db/drizzle-client"
import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm"
import {
  knowledgeRepositories,
  repositoryAccess,
  repositoryItems,
  roles,
  users
} from "@/lib/db/schema"
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
import { deleteRepositoryStorageTree } from "@/lib/repositories/content-platform/storage-cleanup"
import {
  beginRepositoryDeletion,
  finalizeRepositoryDeletion
} from "@/lib/repositories/content-platform/deletion-service"

export interface Repository {
  id: number
  name: string
  description: string | null
  ownerId: number
  isPublic: boolean
  repositoryKind: "durable" | "ephemeral" | "system"
  lifecycleStatus: "active" | "expired" | "deleting" | "deleted"
  retentionDays: number | null
  expiresAt: Date | null
  activeIndexGenerationId: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  ownerName?: string
  itemCount?: number
  canManage: boolean
}

export interface AccessibleRepositorySummary {
  id: number
  name: string
  description: string | null
  isPublic: boolean
  itemCount: number
  lastUpdated: Date | null
  canManage: boolean
}

export interface RepositoryAccessEntry {
  id: number
  repositoryId: number
  userId: number | null
  roleId: number | null
  userEmail: string | null
  userName: string | null
  roleName: string | null
  createdAt: Date | null
}

export interface RepositoryAccessOptions {
  users: Array<{
    id: number
    email: string
    name: string
  }>
  roles: Array<{
    id: number
    name: string
  }>
  nextUserOffset: number | null
}

const REPOSITORY_ACCESS_USER_PAGE_SIZE = 50
const MAX_REPOSITORY_ACCESS_USER_OFFSET = 100_000

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

// Raw repository row shape returned by the Drizzle accessors
type RawRepository = NonNullable<Awaited<ReturnType<typeof drizzleUpdateRepository>>>

// Convert a raw Drizzle repository row to the action-layer Repository type
function mapToRepository(resultRaw: RawRepository): Repository {
  return {
    id: resultRaw.id,
    name: resultRaw.name,
    description: resultRaw.description,
    ownerId: resultRaw.ownerId,
    isPublic: resultRaw.isPublic ?? false,
    repositoryKind: resultRaw.repositoryKind,
    lifecycleStatus: resultRaw.lifecycleStatus,
    retentionDays: resultRaw.retentionDays,
    expiresAt: resultRaw.expiresAt,
    activeIndexGenerationId: resultRaw.activeIndexGenerationId,
    metadata: resultRaw.metadata ?? {},
    createdAt: resultRaw.createdAt ?? new Date(),
    updatedAt: resultRaw.updatedAt ?? new Date(),
    canManage: false,
  }
}

// True when the update input carries at least one mutable field
function hasRepositoryUpdates(input: UpdateRepositoryInput): boolean {
  return (
    input.name !== undefined ||
    input.description !== undefined ||
    input.isPublic !== undefined ||
    input.metadata !== undefined
  )
}

// Build the partial update payload from only the provided fields
function buildRepositoryUpdateData(input: UpdateRepositoryInput): {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
  metadata?: Record<string, unknown> | null;
} {
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

  return updateData
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
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
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
      repositoryKind: resultRaw.repositoryKind,
      lifecycleStatus: resultRaw.lifecycleStatus,
      retentionDays: resultRaw.retentionDays,
      expiresAt: resultRaw.expiresAt,
      activeIndexGenerationId: resultRaw.activeIndexGenerationId,
      metadata: resultRaw.metadata ?? {},
      createdAt: resultRaw.createdAt ?? new Date(),
      updatedAt: resultRaw.updatedAt ?? new Date(),
      canManage: true,
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
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
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

    // A system-managed repository (the Atrium retrieval index, #1056) is
    // immutable through the generic API — masked as not-found so its `isPublic`
    // / `metadata` (and thus the system-managed guard) cannot be flipped.
    await assertNotSystemManagedRepository(input.id)

    // Check if any fields provided
    if (!hasRepositoryUpdates(input)) {
      log.warn("No fields provided for update")
      // Return the actual current row, not a null cast — the ActionState<Repository>
      // contract promises a Repository on success (REV-COR-064).
      const current = await getRepositoryById(input.id)
      if (!current) {
        throw ErrorFactories.dbRecordNotFound("knowledge_repositories", input.id)
      }
      return createSuccess(
        { ...mapToRepository(current), canManage: true },
        "No changes to apply"
      )
    }

    log.info("Updating repository in database", {
      repositoryId: input.id
    })

    // Build update data object with only provided fields
    const updateData = buildRepositoryUpdateData(input)

    const resultRaw = await drizzleUpdateRepository(input.id, updateData)

    if (!resultRaw) {
      log.error("Repository not found for update", { repositoryId: input.id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", input.id)
    }

    // Convert to expected type
    const result: Repository = {
      ...mapToRepository(resultRaw),
      canManage: true,
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
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
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

    // Establish the Repository Manager product boundary before the ownership
    // check so ephemeral/system repository ids remain non-disclosive.
    await assertUserManagedDurableRepositoryForDeletion(id)

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

    // Atomically fence upload/worker producers and snapshot manifests before
    // touching S3. A cleanup failure leaves `deleting` in place so invoking
    // this same action with the repository id safely retries the idempotent
    // sweep instead of reopening a partially deleted repository.
    log.debug("Fencing repository producers before deletion")
    const items = await beginRepositoryDeletion(id)

    log.info("Cleaning repository storage before database deletion", {
      itemCount: items.length,
      repositoryId: id
    })
    const cleanup = await deleteRepositoryStorageTree(id, items)
    log.info("Repository storage cleanup completed", cleanup)

    // Now delete the repository (this will cascade delete all items and chunks)
    log.info("Deleting repository from database", { repositoryId: id })
    const deleted = await finalizeRepositoryDeletion(id)

    if (!deleted) {
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
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository list denied - insufficient permissions", {
        userId: session.sub
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    log.debug("Fetching accessible repositories from database")
    const userId = await getUserIdFromSession(session.sub)
    const [activeRepositories, isAdmin] = await Promise.all([
      getUserAccessibleRepositories(session.sub),
      hasRole("administrator"),
    ])
    // Cleanup failures intentionally retain the producer fence. Keep those
    // rows reachable to their owner (and administrators) after reload so the
    // same action can retry the idempotent S3 sweep and DB finalization.
    const deletionRetries = await executeQuery(
      (db) =>
        db
          .select({
            id: knowledgeRepositories.id,
            name: knowledgeRepositories.name,
            description: knowledgeRepositories.description,
            ownerId: knowledgeRepositories.ownerId,
            ownerName: sql<string | null>`NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), '')`,
            isPublic: knowledgeRepositories.isPublic,
            repositoryKind: knowledgeRepositories.repositoryKind,
            lifecycleStatus: knowledgeRepositories.lifecycleStatus,
            retentionDays: knowledgeRepositories.retentionDays,
            expiresAt: knowledgeRepositories.expiresAt,
            activeIndexGenerationId:
              knowledgeRepositories.activeIndexGenerationId,
            metadata: knowledgeRepositories.metadata,
            createdAt: knowledgeRepositories.createdAt,
            updatedAt: knowledgeRepositories.updatedAt,
            itemCount: sql<number>`(SELECT COUNT(*) FROM ${repositoryItems} WHERE ${repositoryItems.repositoryId} = ${knowledgeRepositories.id})`,
            lastUpdated: sql<Date | null>`(SELECT MAX(updated_at) FROM ${repositoryItems} WHERE ${repositoryItems.repositoryId} = ${knowledgeRepositories.id})`,
          })
          .from(knowledgeRepositories)
          .innerJoin(users, eq(users.id, knowledgeRepositories.ownerId))
          .where(
            and(
              eq(knowledgeRepositories.repositoryKind, "durable"),
              eq(knowledgeRepositories.lifecycleStatus, "deleting"),
              isAdmin
                ? undefined
                : eq(knowledgeRepositories.ownerId, userId)
            )
          )
          .orderBy(knowledgeRepositories.name),
      "listRepositoryDeletionRetries"
    )
    const activeIds = new Set(activeRepositories.map((repository) => repository.id))
    const repositoriesRaw = [
      ...activeRepositories,
      ...deletionRetries.filter((repository) => !activeIds.has(repository.id))
    ]

    const repositories: Repository[] = repositoriesRaw.map((repo) => ({
      id: repo.id,
      name: repo.name,
      description: repo.description,
      ownerId: repo.ownerId,
      isPublic: repo.isPublic ?? false,
      repositoryKind: repo.repositoryKind,
      lifecycleStatus: repo.lifecycleStatus,
      retentionDays: repo.retentionDays,
      expiresAt: repo.expiresAt,
      activeIndexGenerationId: repo.activeIndexGenerationId,
      metadata: repo.metadata ?? {},
      createdAt: repo.createdAt ?? new Date(),
      updatedAt: repo.updatedAt ?? new Date(),
      ownerName: repo.ownerName ?? undefined,
      itemCount: Number(repo.itemCount),
      canManage: isAdmin || repo.ownerId === userId,
    }))

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

/**
 * Item counts for a set of repositories via ONE grouped COUNT(*) query, instead
 * of a full-row SELECT * per repository (which loaded entire text-item bodies
 * just to call items.length). Missing ids default to 0. (REV-COR-069)
 */
async function getRepositoryItemCounts(repositoryIds: number[]): Promise<Map<number, number>> {
  if (repositoryIds.length === 0) return new Map()
  const rows = await executeQuery(
    (db) =>
      db
        .select({ repositoryId: repositoryItems.repositoryId, count: count() })
        .from(repositoryItems)
        .where(inArray(repositoryItems.repositoryId, repositoryIds))
        .groupBy(repositoryItems.repositoryId),
    "getRepositoryItemCounts"
  )
  const counts = new Map<number, number>()
  for (const row of rows) counts.set(row.repositoryId, Number(row.count))
  return counts
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
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository access denied - insufficient permissions", {
        userId: session.sub,
        repositoryId: id
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // Per-repository authorization: the caller must be able to access this
    // repository (public / owner / grant). Closes the IDOR where any capability
    // holder could read any repo's details by id, and excludes system-managed
    // repos (the Atrium index, #1056) which the access model filters out.
    await assertRepositoryReadAccess(id, session.sub)

    log.debug("Fetching repository from database", { repositoryId: id })
    const resultRaw = await getRepositoryById(id)

    if (!resultRaw) {
      log.warn("Repository not found", { repositoryId: id })
      throw ErrorFactories.dbRecordNotFound("knowledge_repositories", id)
    }

    const currentUserId = await getUserIdFromSession(session.sub)
    const [counts, ownerRows, canManage] = await Promise.all([
      getRepositoryItemCounts([id]),
      executeQuery(
        (db) =>
          db
            .select({
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName,
            })
            .from(users)
            .where(eq(users.id, resultRaw.ownerId))
            .limit(1),
        "getRepositoryOwner"
      ),
      canModifyRepository(id, currentUserId),
    ])
    const owner = ownerRows[0]
    const ownerDisplayName = owner
      ? [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim() ||
        owner.email ||
        undefined
      : undefined

    const result: Repository = {
      id: resultRaw.id,
      name: resultRaw.name,
      description: resultRaw.description,
      ownerId: resultRaw.ownerId,
      isPublic: resultRaw.isPublic ?? false,
      repositoryKind: resultRaw.repositoryKind,
      lifecycleStatus: resultRaw.lifecycleStatus,
      retentionDays: resultRaw.retentionDays,
      expiresAt: resultRaw.expiresAt,
      activeIndexGenerationId: resultRaw.activeIndexGenerationId,
      metadata: resultRaw.metadata ?? {},
      createdAt: resultRaw.createdAt ?? new Date(),
      updatedAt: resultRaw.updatedAt ?? new Date(),
      ownerName: ownerDisplayName,
      itemCount: counts.get(id) ?? 0,
      canManage,
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
): Promise<ActionState<RepositoryAccessEntry[]>> {
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
    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Repository access list denied - insufficient permissions", {
        userId: session.sub,
        repositoryId
      })
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    // The ACL is management metadata — restrict to owner/admin, matching
    // grantRepositoryAccess / revokeRepositoryAccess (REV-SEC-083).
    const currentUserId = await getUserIdFromSession(session.sub)
    if (!(await canModifyRepository(repositoryId, currentUserId))) {
      log.warn("Repository access list denied - not owner/admin", { userId: session.sub, repositoryId })
      throw ErrorFactories.authzOwnerRequired("view repository access")
    }
    await assertNotSystemManagedRepository(repositoryId)

    log.debug("Fetching repository access list from database", { repositoryId })
    const access = await getRepositoryAccessList(repositoryId)

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

export async function getRepositoryAccessOptions(
  repositoryId: number,
  search = "",
  userOffset = 0
): Promise<ActionState<RepositoryAccessOptions>> {
  const requestId = generateRequestId()
  const timer = startTimer("getRepositoryAccessOptions")
  const log = createLogger({ requestId, action: "getRepositoryAccessOptions" })

  try {
    const session = await getServerSession()
    if (!session) throw ErrorFactories.authNoSession()
    if (!(await hasCapabilityAccess("knowledge-repositories"))) {
      throw ErrorFactories.authzToolAccessDenied("knowledge-repositories")
    }

    const currentUserId = await getUserIdFromSession(session.sub)
    if (!(await canModifyRepository(repositoryId, currentUserId))) {
      throw ErrorFactories.authzOwnerRequired("manage repository access")
    }
    await assertNotSystemManagedRepository(repositoryId)
    if (
      !Number.isSafeInteger(userOffset) ||
      userOffset < 0 ||
      userOffset > MAX_REPOSITORY_ACCESS_USER_OFFSET
    ) {
      throw ErrorFactories.invalidInput(
        "userOffset",
        userOffset,
        `Must be an integer from 0 to ${MAX_REPOSITORY_ACCESS_USER_OFFSET}`
      )
    }

    const normalizedSearch = search.trim().slice(0, 100)
    const searchTerm = `%${normalizedSearch.replace(/[%_\\]/g, "\\$&")}%`
    const [userRows, roleRows] = await Promise.all([
      executeQuery(
        (db) =>
          db
            .select({
              id: users.id,
              email: users.email,
              firstName: users.firstName,
              lastName: users.lastName,
            })
            .from(users)
            .where(
              normalizedSearch
                ? or(
                    ilike(users.email, searchTerm),
                    ilike(users.firstName, searchTerm),
                    ilike(users.lastName, searchTerm)
                  )
                : undefined
            )
            .orderBy(asc(users.email), asc(users.id))
            .limit(REPOSITORY_ACCESS_USER_PAGE_SIZE + 1)
            .offset(userOffset),
        "getRepositoryAccessOptions.users"
      ),
      executeQuery(
        (db) =>
          db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .orderBy(asc(roles.name)),
        "getRepositoryAccessOptions.roles"
      ),
    ])

    const hasMoreUsers =
      userRows.length > REPOSITORY_ACCESS_USER_PAGE_SIZE
    const visibleUserRows = userRows.slice(
      0,
      REPOSITORY_ACCESS_USER_PAGE_SIZE
    )
    const options: RepositoryAccessOptions = {
      users: visibleUserRows.map((user) => ({
        id: user.id,
        email: user.email ?? "",
        name:
          [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
          user.email ||
          `User ${user.id}`,
      })),
      roles: roleRows,
      nextUserOffset: hasMoreUsers
        ? userOffset + REPOSITORY_ACCESS_USER_PAGE_SIZE
        : null,
    }
    timer({ status: "success", userCount: options.users.length, roleCount: options.roles.length })
    return createSuccess(options, "Access options loaded successfully")
  } catch (error) {
    timer({ status: "error" })
    log.warn("Failed to load repository access options", { repositoryId })
    return handleError(error, "Failed to load repository access options", {
      context: "getRepositoryAccessOptions",
      requestId,
      operation: "getRepositoryAccessOptions",
      metadata: { repositoryId },
    })
  }
}

export async function grantRepositoryAccess(
  repositoryId: number,
  userId: number | null,
  roleId: number | null
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, action: "grantRepositoryAccess" })

  try {
    const session = await getServerSession()
    if (!session) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    // Check if user owns this repository
    const currentUserId = await getUserIdFromSession(session.sub)
    const canModify = await canModifyRepository(repositoryId, currentUserId)
    if (!canModify) {
      log.warn("Grant access denied - not owner", { repositoryId, currentUserId })
      return { isSuccess: false, message: "Only the repository owner can grant access" }
    }
    await assertNotSystemManagedRepository(repositoryId)

    const hasUserId = Number.isInteger(userId) && (userId ?? 0) > 0
    const hasRoleId = Number.isInteger(roleId) && (roleId ?? 0) > 0
    if (hasUserId === hasRoleId) {
      return {
        isSuccess: false,
        message: "Specify exactly one valid user or role",
      }
    }

    if (hasUserId && userId !== null) {
      await grantUserAccess(repositoryId, userId)
    } else if (hasRoleId && roleId !== null) {
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
  const requestId = generateRequestId()
  const log = createLogger({ requestId, action: "revokeRepositoryAccess" })

  try {
    const session = await getServerSession()
    if (!session) {
      return { isSuccess: false, message: "Unauthorized" }
    }

    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    // Get the access record to find the repository and verify ownership
    const accessRecord = await executeQuery(
      (db) => db.select({
        id: repositoryAccess.id,
        repositoryId: repositoryAccess.repositoryId
      })
      .from(repositoryAccess)
      .where(eq(repositoryAccess.id, accessId))
      .limit(1),
      "getAccessRecordForRevoke"
    )

    if (accessRecord.length === 0) {
      return { isSuccess: false, message: "Access record not found" }
    }

    const { repositoryId } = accessRecord[0]

    // Verify the current user owns this repository
    const currentUserId = await getUserIdFromSession(session.sub)
    const canModify = await canModifyRepository(repositoryId, currentUserId)
    if (!canModify) {
      log.warn("Revoke access denied - not owner", { repositoryId, accessId, currentUserId })
      return { isSuccess: false, message: "Only the repository owner can revoke access" }
    }
    await assertNotSystemManagedRepository(repositoryId)

    const deletedCount = await revokeAccessById(accessId)

    if (deletedCount === 0) {
      return { isSuccess: false, message: "Access record not found" }
    }

    return createSuccess(undefined as void, "Access revoked successfully")
  } catch (error) {
    return handleError(error, "Failed to revoke repository access")
  }
}

export async function getUserAccessibleRepositoriesAction(): Promise<
  ActionState<AccessibleRepositorySummary[]>
> {
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

    const hasAccess = await hasCapabilityAccess("knowledge-repositories")
    if (!hasAccess) {
      log.warn("Access denied - missing knowledge-repositories tool access")
      return { isSuccess: false, message: "Access denied. You need knowledge repository access." }
    }

    log.debug("Fetching accessible repositories via Drizzle", { cognitoSub: session.sub })

    const currentUserId = await getUserIdFromSession(session.sub)
    const [repositoriesRaw, isAdmin] = await Promise.all([
      getUserAccessibleRepositories(session.sub),
      hasRole("administrator"),
    ])

    // Convert nullable types to match return type
    const repositories = repositoriesRaw.map(repo => ({
      id: repo.id,
      name: repo.name,
      description: repo.description,
      isPublic: repo.isPublic ?? false,
      itemCount: Number(repo.itemCount),
      lastUpdated: repo.lastUpdated,
      canManage: isAdmin || repo.ownerId === currentUserId,
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
