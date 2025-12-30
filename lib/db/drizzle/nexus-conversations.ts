/**
 * Drizzle Nexus Conversations Operations
 *
 * Nexus conversation and folder CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **CRITICAL - Nexus System**: This system is fragile and has broken multiple times.
 * Follow documented patterns exactly. See /docs/features/nexus-conversation-architecture.md
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #533 - Migrate Nexus Conversations core tables to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, or, desc, sql, isNull } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  nexusConversations,
  nexusFolders,
  nexusConversationEvents,
} from "@/lib/db/schema";
import type {
  NexusConversationMetadata,
  NexusFolderSettings,
  NexusConversationEventData,
} from "@/lib/db/types/jsonb";

// ============================================
// Constants
// ============================================

/** Default pagination limit for conversation queries */
export const DEFAULT_CONVERSATION_LIMIT = 20;

/** Default folder color (gray-500) */
export const DEFAULT_FOLDER_COLOR = "#6B7280";

/** Default folder icon */
export const DEFAULT_FOLDER_ICON = "folder";

// ============================================
// Types
// ============================================

export interface ConversationListItem {
  id: string;
  title: string | null;
  provider: string;
  modelUsed: string | null;
  messageCount: number | null;
  totalTokens: number | null;
  lastMessageAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  isArchived: boolean | null;
  isPinned: boolean | null;
  externalId: string | null;
  cacheKey: string | null;
}

export interface CreateConversationData {
  userId: number;
  title?: string;
  provider: string;
  modelId?: string;
  metadata?: NexusConversationMetadata;
}

export interface UpdateConversationData {
  title?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  folderId?: string | null;
  metadata?: NexusConversationMetadata;
}

export interface ConversationListOptions {
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface CreateFolderData {
  userId: number;
  name: string;
  parentId?: string;
  color?: string;
  icon?: string;
  settings?: NexusFolderSettings;
}

export interface UpdateFolderData {
  name?: string;
  parentId?: string | null;
  color?: string;
  icon?: string;
  sortOrder?: number;
  isExpanded?: boolean;
  settings?: NexusFolderSettings;
}

// ============================================
// Conversation Query Operations
// ============================================

/**
 * Get conversations for a user with pagination
 * Returns conversations ordered by pinned status and last message time
 */
export async function getConversations(
  userId: number,
  options: ConversationListOptions = {}
) {
  const { limit = DEFAULT_CONVERSATION_LIMIT, offset = 0, includeArchived = false } = options;

  return executeQuery(
    (db) =>
      db
        .select({
          id: nexusConversations.id,
          title: nexusConversations.title,
          provider: nexusConversations.provider,
          modelUsed: nexusConversations.modelUsed,
          messageCount: nexusConversations.messageCount,
          totalTokens: nexusConversations.totalTokens,
          lastMessageAt: nexusConversations.lastMessageAt,
          createdAt: nexusConversations.createdAt,
          updatedAt: nexusConversations.updatedAt,
          isArchived: nexusConversations.isArchived,
          isPinned: nexusConversations.isPinned,
          externalId: nexusConversations.externalId,
          cacheKey: nexusConversations.cacheKey,
        })
        .from(nexusConversations)
        .where(
          includeArchived
            ? eq(nexusConversations.userId, userId)
            : and(
                eq(nexusConversations.userId, userId),
                or(
                  eq(nexusConversations.isArchived, false),
                  isNull(nexusConversations.isArchived)
                )
              )
        )
        // Order by pinned first (using COALESCE to treat null as false)
        // Then by most recent activity (last message or update time)
        .orderBy(
          desc(sql`COALESCE(${nexusConversations.isPinned}, false)`),
          desc(sql`COALESCE(${nexusConversations.lastMessageAt}, ${nexusConversations.updatedAt})`)
        )
        .limit(limit)
        .offset(offset),
    "getConversations"
  );
}

/**
 * Get total count of conversations for a user
 */
export async function getConversationCount(
  userId: number,
  includeArchived: boolean = false
) {
  const result = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`CAST(count(*) AS integer)` })
        .from(nexusConversations)
        .where(
          includeArchived
            ? eq(nexusConversations.userId, userId)
            : and(
                eq(nexusConversations.userId, userId),
                or(
                  eq(nexusConversations.isArchived, false),
                  isNull(nexusConversations.isArchived)
                )
              )
        ),
    "getConversationCount"
  );

  return result[0]?.count ?? 0;
}

/**
 * Get a single conversation by ID
 * Also verifies user ownership
 */
export async function getConversationById(
  conversationId: string,
  userId: number
) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, conversationId),
            eq(nexusConversations.userId, userId)
          )
        )
        .limit(1),
    "getConversationById"
  );

  return result[0] || null;
}

// ============================================
// Conversation CRUD Operations
// ============================================

/**
 * Create a new conversation
 * Validates required fields before insertion
 */
export async function createConversation(data: CreateConversationData) {
  // Validate required fields
  if (!data.userId || data.userId <= 0) {
    throw new Error("userId is required and must be a positive integer");
  }

  if (!data.provider || data.provider.trim() === "") {
    throw new Error("provider is required and cannot be empty");
  }

  // Use provided title or default (handles undefined, null, empty, or whitespace-only strings)
  const title = data.title?.trim() || "New Conversation";

  const result = await executeQuery(
    (db) =>
      db
        .insert(nexusConversations)
        .values({
          userId: data.userId,
          title,
          provider: data.provider,
          modelUsed: data.modelId,
          messageCount: 0,
          totalTokens: 0,
          metadata: data.metadata || {},
        })
        .returning({
          id: nexusConversations.id,
          title: nexusConversations.title,
          provider: nexusConversations.provider,
          modelId: nexusConversations.modelUsed,
          createdAt: nexusConversations.createdAt,
          updatedAt: nexusConversations.updatedAt,
        }),
    "createConversation"
  );

  return result[0];
}

/**
 * Record a conversation event
 *
 * @param conversationId - Conversation UUID
 * @param eventType - Event type from NexusConversationEventData union
 * @param userId - User who triggered the event
 * @param additionalData - Additional event-specific data
 */
export async function recordConversationEvent(
  conversationId: string,
  eventType: NexusConversationEventData['eventType'],
  userId: number,
  additionalData: Record<string, unknown> = {}
) {
  // Construct full event data matching NexusConversationEventData type
  const eventData: NexusConversationEventData = {
    eventType,
    userId,
    timestamp: new Date().toISOString(),
    ...additionalData,
  };

  return executeQuery(
    (db) =>
      db.insert(nexusConversationEvents).values({
        conversationId,
        eventType,
        eventData,
      }),
    "recordConversationEvent"
  );
}

/**
 * Update a conversation
 * Verifies user ownership before update
 * Validates input to prevent security issues
 */
export async function updateConversation(
  conversationId: string,
  userId: number,
  updates: UpdateConversationData
) {
  // Validate title length if provided (database limit is 500 chars)
  if (updates.title !== undefined && updates.title !== null) {
    if (typeof updates.title !== 'string') {
      throw new TypeError("title must be a string");
    }
    if (updates.title.length > 500) {
      throw new Error("title cannot exceed 500 characters");
    }
  }

  // Verify folder ownership if folderId is being changed
  // Note: TOCTOU (Time-of-Check-Time-of-Use) race condition exists here - folder could be
  // deleted between this check and the update. However, this is acceptable because:
  // 1. The database has a foreign key constraint (nexus_conversations.folder_id references nexus_folders.id)
  // 2. Low likelihood of race (requires precise timing)
  // 3. Database will reject the update if folder is deleted, preventing data corruption
  // Alternative: Use transaction or rely solely on FK constraint (no upfront validation)
  if (updates.folderId !== undefined && updates.folderId !== null) {
    const folder = await getFolderById(updates.folderId, userId);
    if (!folder) {
      throw new Error("Folder not found or access denied");
    }
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(nexusConversations)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(nexusConversations.id, conversationId),
            eq(nexusConversations.userId, userId)
          )
        )
        .returning({
          id: nexusConversations.id,
          title: nexusConversations.title,
          isArchived: nexusConversations.isArchived,
          isPinned: nexusConversations.isPinned,
          updatedAt: nexusConversations.updatedAt,
        }),
    "updateConversation"
  );

  return result[0] || null;
}

/**
 * Archive a conversation
 */
export async function archiveConversation(
  conversationId: string,
  userId: number
) {
  return updateConversation(conversationId, userId, { isArchived: true });
}

/**
 * Unarchive a conversation
 */
export async function unarchiveConversation(
  conversationId: string,
  userId: number
) {
  return updateConversation(conversationId, userId, { isArchived: false });
}

/**
 * Delete a conversation
 * Verifies user ownership before delete
 */
export async function deleteConversation(
  conversationId: string,
  userId: number
) {
  const result = await executeQuery(
    (db) =>
      db
        .delete(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, conversationId),
            eq(nexusConversations.userId, userId)
          )
        )
        .returning({ id: nexusConversations.id }),
    "deleteConversation"
  );

  return result[0] || null;
}

// ============================================
// Folder Query Operations
// ============================================

/**
 * Get all folders for a user
 */
export async function getFolders(userId: number) {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(nexusFolders)
        .where(eq(nexusFolders.userId, userId))
        .orderBy(nexusFolders.sortOrder, nexusFolders.name),
    "getFolders"
  );
}

/**
 * Get a single folder by ID
 * Also verifies user ownership
 */
export async function getFolderById(folderId: string, userId: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusFolders)
        .where(
          and(eq(nexusFolders.id, folderId), eq(nexusFolders.userId, userId))
        )
        .limit(1),
    "getFolderById"
  );

  return result[0] || null;
}

// ============================================
// Folder CRUD Operations
// ============================================

/**
 * Create a new folder
 */
export async function createFolder(data: CreateFolderData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(nexusFolders)
        .values({
          userId: data.userId,
          name: data.name,
          parentId: data.parentId,
          color: data.color || DEFAULT_FOLDER_COLOR,
          icon: data.icon || DEFAULT_FOLDER_ICON,
          settings: data.settings || {},
        })
        .returning(),
    "createFolder"
  );

  return result[0];
}

/**
 * Update a folder
 * Verifies user ownership before update
 * Validates input to prevent security issues
 */
export async function updateFolder(
  folderId: string,
  userId: number,
  updates: UpdateFolderData
) {
  // Validate name length if provided (database limit is 255 chars)
  if (updates.name !== undefined && updates.name !== null) {
    if (typeof updates.name !== 'string') {
      throw new TypeError("name must be a string");
    }
    if (updates.name.trim() === "") {
      throw new Error("name cannot be empty");
    }
    if (updates.name.length > 255) {
      throw new Error("name cannot exceed 255 characters");
    }
  }

  // Validate color format if provided (database limit is 7 chars for hex colors)
  if (updates.color !== undefined && updates.color !== null) {
    if (typeof updates.color !== 'string') {
      throw new TypeError("color must be a string");
    }
    // Validate hex color format (#RRGGBB)
    if (!/^#[\dA-Fa-f]{6}$/.test(updates.color)) {
      throw new Error("color must be a valid hex color (e.g., #6B7280)");
    }
  }

  // Verify parent folder ownership if parentId is being changed
  if (updates.parentId !== undefined && updates.parentId !== null) {
    const parentFolder = await getFolderById(updates.parentId, userId);
    if (!parentFolder) {
      throw new Error("Parent folder not found or access denied");
    }
    // Prevent circular reference (folder cannot be its own parent)
    if (updates.parentId === folderId) {
      throw new Error("Folder cannot be its own parent");
    }
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(nexusFolders)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(
          and(eq(nexusFolders.id, folderId), eq(nexusFolders.userId, userId))
        )
        .returning(),
    "updateFolder"
  );

  return result[0] || null;
}

/**
 * Delete a folder
 * Verifies user ownership before delete
 * Uses transaction to prevent race condition between unlinking and deleting
 */
export async function deleteFolder(folderId: string, userId: number) {
  // Use transaction to atomically unlink conversations and delete folder
  // executeQuery wrapper provides logging, metrics, and circuit breaker protection
  const result = await executeQuery(
    (db) =>
      db.transaction(async (tx) => {
        // First, unset the folder_id for any conversations in this folder
        await tx
          .update(nexusConversations)
          .set({ folderId: null, updatedAt: new Date() })
          .where(
            and(
              eq(nexusConversations.folderId, folderId),
              eq(nexusConversations.userId, userId)
            )
          );

        // Then delete the folder
        const deleteResult = await tx
          .delete(nexusFolders)
          .where(
            and(eq(nexusFolders.id, folderId), eq(nexusFolders.userId, userId))
          )
          .returning({ id: nexusFolders.id });

        return deleteResult[0] || null;
      }),
    "deleteFolder"
  );

  return result;
}

/**
 * Move conversations to a folder
 * Uses batch update for efficiency instead of individual updates
 */
export async function moveConversationsToFolder(
  conversationIds: string[],
  folderId: string | null,
  userId: number
) {
  if (conversationIds.length === 0) {
    return [];
  }

  // Verify folder ownership once if folderId is provided
  if (folderId !== null) {
    const folder = await getFolderById(folderId, userId);
    if (!folder) {
      throw new Error("Folder not found or access denied");
    }
  }

  // Batch update all conversations in a single query
  const results = await executeQuery(
    (db) =>
      db
        .update(nexusConversations)
        .set({
          folderId,
          updatedAt: new Date(),
        })
        .where(
          and(
            sql`${nexusConversations.id} = ANY(${conversationIds})`,
            eq(nexusConversations.userId, userId)
          )
        )
        .returning({
          id: nexusConversations.id,
          folderId: nexusConversations.folderId,
        }),
    "moveConversationsToFolder"
  );

  return results;
}
