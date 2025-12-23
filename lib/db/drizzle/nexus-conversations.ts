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
import { createLogger, generateRequestId } from "@/lib/logger";
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
        .select({ count: sql<number>`count(*)::int` })
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

  // Use provided title or default, but trim whitespace
  const title = (data.title || "New Conversation").trim() || "New Conversation";

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
 * @param eventType - Event type (e.g., 'conversation_created', 'conversation_archived')
 * @param userId - User who triggered the event
 * @param additionalData - Additional event-specific data
 */
export async function recordConversationEvent(
  conversationId: string,
  eventType: string,
  userId: number,
  additionalData: Record<string, unknown> = {}
) {
  // Construct full event data matching NexusConversationEventData type
  const eventData: NexusConversationEventData = {
    eventType: eventType as NexusConversationEventData['eventType'],
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
 */
export async function updateConversation(
  conversationId: string,
  userId: number,
  updates: UpdateConversationData
) {
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
          color: data.color || "#6B7280",
          icon: data.icon || "folder",
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
 */
export async function updateFolder(
  folderId: string,
  userId: number,
  updates: UpdateFolderData
) {
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
 */
export async function deleteFolder(folderId: string, userId: number) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, operation: "deleteFolder" });

  // First, unset the folder_id for any conversations in this folder
  await executeQuery(
    (db) =>
      db
        .update(nexusConversations)
        .set({ folderId: null, updatedAt: new Date() })
        .where(
          and(
            eq(nexusConversations.folderId, folderId),
            eq(nexusConversations.userId, userId)
          )
        ),
    "unlinkConversationsFromFolder"
  );

  log.debug("Unlinked conversations from folder", { folderId, userId });

  // Then delete the folder
  const result = await executeQuery(
    (db) =>
      db
        .delete(nexusFolders)
        .where(
          and(eq(nexusFolders.id, folderId), eq(nexusFolders.userId, userId))
        )
        .returning({ id: nexusFolders.id }),
    "deleteFolder"
  );

  return result[0] || null;
}

/**
 * Move conversations to a folder
 */
export async function moveConversationsToFolder(
  conversationIds: string[],
  folderId: string | null,
  userId: number
) {
  if (conversationIds.length === 0) {
    return [];
  }

  const results = await Promise.all(
    conversationIds.map((id) =>
      updateConversation(id, userId, { folderId })
    )
  );

  return results.filter(Boolean);
}
