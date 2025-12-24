/**
 * Drizzle Knowledge Repository Operations
 *
 * Knowledge repository, repository item, and repository access CRUD operations
 * migrated from RDS Data API to Drizzle ORM. All functions use executeQuery()
 * wrapper with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **Authorization Requirements**:
 * - Verify user owns the repository (repository.ownerId matches session.userId)
 * - Verify user has access via repository_access table
 * - Check if repository is public (isPublic = true)
 * - Use @/lib/auth/server-session helpers
 *
 * **Required Database Indexes** (for optimal access control query performance):
 * ```sql
 * -- Repository access queries use these indexes for efficient JOINs
 * CREATE INDEX idx_repository_items_repository_id ON repository_items(repository_id);
 * CREATE INDEX idx_repository_item_chunks_item_id ON repository_item_chunks(item_id);
 * CREATE INDEX idx_repository_access_repository_id ON repository_access(repository_id);
 * CREATE INDEX idx_repository_access_user_id ON repository_access(user_id);
 * CREATE INDEX idx_repository_access_role_id ON repository_access(role_id);
 * CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
 * CREATE INDEX idx_user_roles_role_id ON user_roles(role_id);
 * CREATE INDEX idx_knowledge_repositories_owner_id ON knowledge_repositories(owner_id);
 * CREATE INDEX idx_knowledge_repositories_is_public ON knowledge_repositories(is_public) WHERE is_public = true;
 * ```
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #536 - Migrate Knowledge & Document queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc, or, sql, inArray, isNotNull, type SQL } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  knowledgeRepositories,
  repositoryItems,
  repositoryItemChunks,
  repositoryAccess,
  users,
  userRoles,
} from "@/lib/db/schema";
import type {
  SelectKnowledgeRepository,
  SelectRepositoryItem,
  SelectRepositoryItemChunk,
  SelectRepositoryAccess,
} from "@/lib/db/types";
import { createLogger, sanitizeForLogging } from "@/lib/logger";

// ============================================
// Constants
// ============================================

/**
 * Maximum number of chunks that can be inserted in a single batch operation
 * Prevents memory issues and database connection timeouts
 */
const MAX_BATCH_SIZE = 1000;

// ============================================
// Types
// ============================================

/**
 * Repository metadata stored in JSONB column
 */
export interface RepositoryMetadata {
  type?: "documentation" | "knowledge" | "training" | "custom";
  sourceUrl?: string;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Repository item processing status
 */
export type ProcessingStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/**
 * Data for creating a new repository
 */
export interface CreateRepositoryData {
  name: string;
  description?: string | null;
  ownerId: number;
  isPublic?: boolean;
  metadata?: RepositoryMetadata | null;
}

/**
 * Data for updating a repository
 */
export interface UpdateRepositoryData {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
  metadata?: RepositoryMetadata | null;
}

/**
 * Data for creating a repository item
 */
export interface CreateRepositoryItemData {
  repositoryId: number;
  type: string;
  name: string;
  source: string;
  metadata?: Record<string, unknown> | null;
  processingStatus?: ProcessingStatus;
}

/**
 * Data for creating a repository item chunk
 *
 * **Note on Embeddings**: Repository item chunks store vector embeddings in a
 * dedicated pgvector column for efficient vector similarity search and indexing.
 * Document chunks have an unused embedding JSONB column (schema exists but not
 * currently populated). Repository embeddings are actively used for RAG operations.
 */
export interface CreateChunkData {
  itemId: number;
  content: string;
  chunkIndex: number;
  metadata?: Record<string, unknown> | null;
  /** Vector embedding stored in dedicated pgvector column for semantic search */
  embedding?: number[] | null;
  tokens?: number | null;
}

/**
 * Repository with access check result
 */
export interface RepositoryWithAccess {
  id: number;
  name: string;
  isAccessible: boolean;
}

// ============================================
// Knowledge Repository Query Operations
// ============================================

/**
 * Get a repository by ID
 */
export async function getRepositoryById(
  id: number
): Promise<SelectKnowledgeRepository | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, id))
        .limit(1),
    "getRepositoryById"
  );

  return result[0] || null;
}

/**
 * Get repositories by owner ID
 */
export async function getRepositoriesByOwnerId(
  ownerId: number
): Promise<SelectKnowledgeRepository[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.ownerId, ownerId))
        .orderBy(desc(knowledgeRepositories.createdAt)),
    "getRepositoriesByOwnerId"
  );

  return result;
}

/**
 * Get all public repositories
 */
export async function getPublicRepositories(): Promise<
  SelectKnowledgeRepository[]
> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(knowledgeRepositories)
        .where(eq(knowledgeRepositories.isPublic, true))
        .orderBy(desc(knowledgeRepositories.createdAt)),
    "getPublicRepositories"
  );

  return result;
}

/**
 * Check if user has access to specified repository IDs
 * Returns only the IDs that the user can access
 *
 * Access is granted if:
 * - Repository is public
 * - User owns the repository
 * - User has direct access via repository_access
 * - User has role-based access via repository_access + user_roles
 */
export async function getAccessibleRepositoryIds(
  repositoryIds: number[],
  userId: number
): Promise<number[]> {
  if (repositoryIds.length === 0) {
    return [];
  }

  // This query checks multiple access conditions
  // Use explicit NULL checks for LEFT JOIN columns to avoid false positives
  const result = await executeQuery(
    (db) =>
      db
        .selectDistinct({ id: knowledgeRepositories.id })
        .from(knowledgeRepositories)
        .leftJoin(
          repositoryAccess,
          eq(repositoryAccess.repositoryId, knowledgeRepositories.id)
        )
        .leftJoin(userRoles, eq(userRoles.roleId, repositoryAccess.roleId))
        .where(
          and(
            inArray(knowledgeRepositories.id, repositoryIds),
            or(
              // Public repositories
              eq(knowledgeRepositories.isPublic, true),
              // User owns the repository
              eq(knowledgeRepositories.ownerId, userId),
              // Direct user access (must check not null from LEFT JOIN)
              and(
                isNotNull(repositoryAccess.userId),
                eq(repositoryAccess.userId, userId)
              ),
              // Role-based access (must check not null from LEFT JOIN)
              and(isNotNull(userRoles.userId), eq(userRoles.userId, userId))
            )
          )
        ),
    "getAccessibleRepositoryIds"
  );

  return result.map((r) => r.id);
}

/**
 * Get accessible repositories by user cognito sub
 * Useful for access control checks with session data
 */
export async function getAccessibleRepositoriesByCognitoSub(
  repositoryIds: number[],
  cognitoSub: string,
  assistantOwnerSub?: string
): Promise<RepositoryWithAccess[]> {
  if (repositoryIds.length === 0) {
    return [];
  }

  // Get user IDs from cognito subs in a single query
  const cognitoSubs = assistantOwnerSub
    ? [cognitoSub, assistantOwnerSub]
    : [cognitoSub];

  const userResults = await executeQuery(
    (db) =>
      db
        .select({ cognitoSub: users.cognitoSub, id: users.id })
        .from(users)
        .where(inArray(users.cognitoSub, cognitoSubs)),
    "getUsersByCognitoSubs"
  );

  const userId = userResults.find((u) => u.cognitoSub === cognitoSub)?.id;
  const assistantOwnerId = assistantOwnerSub
    ? userResults.find((u) => u.cognitoSub === assistantOwnerSub)?.id ?? null
    : null;

  // Get all repositories with access check
  // Use explicit NULL checks for LEFT JOIN columns to avoid false positives
  // Build conditions array and filter out false/null/undefined values
  const accessConditions = [
    eq(knowledgeRepositories.isPublic, true),
    userId && eq(knowledgeRepositories.ownerId, userId),
    assistantOwnerId && eq(knowledgeRepositories.ownerId, assistantOwnerId),
    userId &&
      and(isNotNull(repositoryAccess.userId), eq(repositoryAccess.userId, userId)),
    userId && and(isNotNull(userRoles.userId), eq(userRoles.userId, userId)),
  ].filter((condition): condition is SQL<unknown> => Boolean(condition));

  const result = await executeQuery(
    (db) =>
      db
        .selectDistinct({
          id: knowledgeRepositories.id,
          name: knowledgeRepositories.name,
        })
        .from(knowledgeRepositories)
        .leftJoin(
          repositoryAccess,
          eq(repositoryAccess.repositoryId, knowledgeRepositories.id)
        )
        .leftJoin(userRoles, eq(userRoles.roleId, repositoryAccess.roleId))
        .where(
          and(
            inArray(knowledgeRepositories.id, repositoryIds),
            or(...accessConditions)
          )
        ),
    "getAccessibleRepositoriesByCognitoSub"
  );

  const accessibleIds = new Set(result.map((r) => r.id));
  const repositoryMap = new Map(result.map((r) => [r.id, r.name]));

  return repositoryIds.map((id) => ({
    id,
    name: repositoryMap.get(id) ?? "",
    isAccessible: accessibleIds.has(id),
  }));
}

// ============================================
// Knowledge Repository CRUD Operations
// ============================================

/**
 * Create a new repository
 */
export async function createRepository(
  data: CreateRepositoryData
): Promise<SelectKnowledgeRepository> {
  const log = createLogger({ module: "drizzle-knowledge-repositories" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(knowledgeRepositories)
        .values({
          name: data.name,
          description: data.description ?? null,
          ownerId: data.ownerId,
          isPublic: data.isPublic ?? false,
          metadata: data.metadata ?? null,
        })
        .returning(),
    "createRepository"
  );

  if (!result[0]) {
    log.error("Failed to create repository", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create repository");
  }

  return result[0];
}

/**
 * Update a repository
 */
export async function updateRepository(
  id: number,
  data: UpdateRepositoryData
): Promise<SelectKnowledgeRepository | null> {
  const updateData = {
    ...data,
    metadata: data.metadata ?? null,
    updatedAt: new Date(),
  };

  const result = await executeQuery(
    (db) =>
      db
        .update(knowledgeRepositories)
        .set(updateData)
        .where(eq(knowledgeRepositories.id, id))
        .returning(),
    "updateRepository"
  );

  return result[0] || null;
}

/**
 * Delete a repository
 * Note: This will cascade delete repository items and chunks
 * @returns Number of repositories deleted (0 or 1)
 */
export async function deleteRepository(id: number): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(knowledgeRepositories)
        .where(eq(knowledgeRepositories.id, id))
        .returning({ id: knowledgeRepositories.id }),
    "deleteRepository"
  );

  return result.length;
}

// ============================================
// Repository Access Operations
// ============================================

/**
 * Grant user access to a repository
 */
export async function grantUserAccess(
  repositoryId: number,
  userId: number
): Promise<SelectRepositoryAccess> {
  const log = createLogger({ module: "drizzle-knowledge-repositories" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(repositoryAccess)
        .values({
          repositoryId,
          userId,
        })
        .returning(),
    "grantUserAccess"
  );

  if (!result[0]) {
    log.error("Failed to grant user access", { repositoryId, userId });
    throw new Error("Failed to grant user access");
  }

  return result[0];
}

/**
 * Grant role-based access to a repository
 */
export async function grantRoleAccess(
  repositoryId: number,
  roleId: number
): Promise<SelectRepositoryAccess> {
  const log = createLogger({ module: "drizzle-knowledge-repositories" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(repositoryAccess)
        .values({
          repositoryId,
          roleId,
        })
        .returning(),
    "grantRoleAccess"
  );

  if (!result[0]) {
    log.error("Failed to grant role access", { repositoryId, roleId });
    throw new Error("Failed to grant role access");
  }

  return result[0];
}

/**
 * Revoke user access from a repository
 */
export async function revokeUserAccess(
  repositoryId: number,
  userId: number
): Promise<{ id: number } | null> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(repositoryAccess)
        .where(
          and(
            eq(repositoryAccess.repositoryId, repositoryId),
            eq(repositoryAccess.userId, userId)
          )
        )
        .returning({ id: repositoryAccess.id }),
    "revokeUserAccess"
  );

  return result[0] || null;
}

/**
 * Revoke role-based access from a repository
 */
export async function revokeRoleAccess(
  repositoryId: number,
  roleId: number
): Promise<{ id: number } | null> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(repositoryAccess)
        .where(
          and(
            eq(repositoryAccess.repositoryId, repositoryId),
            eq(repositoryAccess.roleId, roleId)
          )
        )
        .returning({ id: repositoryAccess.id }),
    "revokeRoleAccess"
  );

  return result[0] || null;
}

/**
 * Get all access entries for a repository
 */
export async function getRepositoryAccessList(
  repositoryId: number
): Promise<SelectRepositoryAccess[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryAccess)
        .where(eq(repositoryAccess.repositoryId, repositoryId)),
    "getRepositoryAccessList"
  );

  return result;
}

// ============================================
// Repository Item Operations
// ============================================

/**
 * Get items for a repository
 */
export async function getRepositoryItems(
  repositoryId: number
): Promise<SelectRepositoryItem[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryItems)
        .where(eq(repositoryItems.repositoryId, repositoryId))
        .orderBy(desc(repositoryItems.createdAt)),
    "getRepositoryItems"
  );

  return result;
}

/**
 * Get a repository item by ID
 */
export async function getRepositoryItemById(
  id: number
): Promise<SelectRepositoryItem | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryItems)
        .where(eq(repositoryItems.id, id))
        .limit(1),
    "getRepositoryItemById"
  );

  return result[0] || null;
}

/**
 * Create a repository item
 */
export async function createRepositoryItem(
  data: CreateRepositoryItemData
): Promise<SelectRepositoryItem> {
  const log = createLogger({ module: "drizzle-knowledge-repositories" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(repositoryItems)
        .values({
          repositoryId: data.repositoryId,
          type: data.type,
          name: data.name,
          source: data.source,
          metadata: data.metadata ?? null,
          processingStatus: data.processingStatus ?? "pending",
        })
        .returning(),
    "createRepositoryItem"
  );

  if (!result[0]) {
    log.error("Failed to create repository item", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create repository item");
  }

  return result[0];
}

/**
 * Update repository item processing status
 */
export async function updateRepositoryItemStatus(
  id: number,
  status: ProcessingStatus,
  error?: string | null
): Promise<SelectRepositoryItem | null> {
  const updateData: Record<string, unknown> = {
    processingStatus: status,
    updatedAt: new Date(),
  };

  if (error !== undefined) {
    updateData.processingError = error;
  } else if (status === "completed") {
    // Clear error on successful completion
    updateData.processingError = null;
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(repositoryItems)
        .set(updateData)
        .where(eq(repositoryItems.id, id))
        .returning(),
    "updateRepositoryItemStatus"
  );

  return result[0] || null;
}

/**
 * Delete a repository item
 * Note: Chunks are automatically deleted via cascade
 * @returns Number of items deleted (0 or 1)
 */
export async function deleteRepositoryItem(id: number): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(repositoryItems)
        .where(eq(repositoryItems.id, id))
        .returning({ id: repositoryItems.id }),
    "deleteRepositoryItem"
  );

  return result.length;
}

// ============================================
// Repository Item Chunk Operations
// ============================================

/**
 * Get chunks for a repository item
 */
export async function getRepositoryItemChunks(
  itemId: number
): Promise<SelectRepositoryItemChunk[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(repositoryItemChunks)
        .where(eq(repositoryItemChunks.itemId, itemId))
        .orderBy(repositoryItemChunks.chunkIndex),
    "getRepositoryItemChunks"
  );

  return result;
}

/**
 * Create a repository item chunk
 */
export async function createRepositoryItemChunk(
  data: CreateChunkData
): Promise<SelectRepositoryItemChunk> {
  const log = createLogger({ module: "drizzle-knowledge-repositories" });

  const result = await executeQuery(
    (db) =>
      db
        .insert(repositoryItemChunks)
        .values({
          itemId: data.itemId,
          content: data.content,
          chunkIndex: data.chunkIndex,
          metadata: data.metadata ?? null,
          embedding: data.embedding ?? null,
          tokens: data.tokens ?? null,
        })
        .returning(),
    "createRepositoryItemChunk"
  );

  if (!result[0]) {
    log.error("Failed to create repository item chunk", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create repository item chunk");
  }

  return result[0];
}

/**
 * Batch insert repository item chunks
 */
export async function batchInsertRepositoryItemChunks(
  chunks: CreateChunkData[]
): Promise<SelectRepositoryItemChunk[]> {
  const log = createLogger({ module: "drizzle-knowledge-repositories" });

  if (chunks.length === 0) {
    return [];
  }

  if (chunks.length > MAX_BATCH_SIZE) {
    log.error("Batch size exceeds maximum", {
      requestedSize: chunks.length,
      maxSize: MAX_BATCH_SIZE,
    });
    throw new Error(
      `Batch insert size (${chunks.length}) exceeds maximum allowed (${MAX_BATCH_SIZE})`
    );
  }

  log.debug("Batch inserting repository item chunks", { count: chunks.length });

  const values = chunks.map((chunk) => ({
    itemId: chunk.itemId,
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    metadata: chunk.metadata ?? null,
    embedding: chunk.embedding ?? null,
    tokens: chunk.tokens ?? null,
  }));

  const result = await executeQuery(
    (db) => db.insert(repositoryItemChunks).values(values).returning(),
    "batchInsertRepositoryItemChunks"
  );

  log.debug("Batch insert complete", {
    requestedCount: chunks.length,
    insertedCount: result.length,
  });

  return result;
}

/**
 * Delete chunks for a repository item
 */
export async function deleteRepositoryItemChunks(
  itemId: number
): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(repositoryItemChunks)
        .where(eq(repositoryItemChunks.itemId, itemId))
        .returning({ id: repositoryItemChunks.id }),
    "deleteRepositoryItemChunks"
  );

  return result.length;
}
