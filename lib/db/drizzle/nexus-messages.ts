/**
 * Drizzle Nexus Messages Operations
 *
 * Nexus message CRUD operations migrated from RDS Data API to Drizzle ORM.
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
 * Issue #534 - Migrate Nexus Messages & Artifacts to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, asc, sql, desc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  nexusMessages,
  nexusConversations,
  aiModels,
} from "@/lib/db/schema";
import { countAsInt } from "@/lib/db/drizzle/helpers/pagination";
import type { SelectNexusMessage } from "@/lib/db/types";

// ============================================
// Types
// ============================================

/**
 * Token usage statistics for a message
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Message part types for AI SDK v5 format
 */
export interface MessagePart {
  type: "text" | "image" | "tool_call" | "tool_result";
  text?: string;
  image?: string;
  toolCall?: unknown;
  toolResult?: unknown;
}

/**
 * Data for creating a new message
 */
export interface CreateMessageData {
  id?: string; // Optional - will use default UUID if not provided
  conversationId: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: MessagePart[];
  modelId?: number;
  reasoningContent?: string;
  tokenUsage?: TokenUsage;
  finishReason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Data for updating an existing message
 */
export interface UpdateMessageData {
  content?: string;
  parts?: MessagePart[];
  modelId?: number;
  reasoningContent?: string;
  tokenUsage?: TokenUsage;
  finishReason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Message with model information from LEFT JOIN
 */
export interface MessageWithModel {
  id: string;
  conversationId: string;
  role: string;
  content: string | null;
  parts: MessagePart[] | null;
  modelId: number | null;
  reasoningContent: string | null;
  tokenUsage: TokenUsage | null;
  finishReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  modelProvider?: string | null;
  modelName?: string | null;
}

/**
 * Options for message queries
 */
export interface MessageQueryOptions {
  limit?: number;
  offset?: number;
  includeModel?: boolean;
}

// ============================================
// Constants
// ============================================

/** Default pagination limit for message queries */
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Maximum allowed messages per query */
export const MAX_MESSAGE_LIMIT = 1000;

// ============================================
// Query Operations
// ============================================

/**
 * Get messages for a conversation with pagination
 * Returns messages ordered by created_at ASC (oldest first)
 *
 * When includeModel=true, returns MessageWithModel[] with provider/model info
 * When includeModel=false, returns SelectNexusMessage[] without model info
 */
export async function getMessagesByConversation(
  conversationId: string,
  options: MessageQueryOptions = {}
): Promise<MessageWithModel[] | SelectNexusMessage[]> {
  const {
    limit = DEFAULT_MESSAGE_LIMIT,
    offset = 0,
    includeModel = false,
  } = options;

  // Clamp limit to max allowed
  const clampedLimit = Math.min(Math.max(limit, 1), MAX_MESSAGE_LIMIT);

  if (includeModel) {
    return executeQuery(
      (db) =>
        db
          .select({
            id: nexusMessages.id,
            conversationId: nexusMessages.conversationId,
            role: nexusMessages.role,
            content: nexusMessages.content,
            parts: nexusMessages.parts,
            modelId: nexusMessages.modelId,
            reasoningContent: nexusMessages.reasoningContent,
            tokenUsage: nexusMessages.tokenUsage,
            finishReason: nexusMessages.finishReason,
            metadata: nexusMessages.metadata,
            createdAt: nexusMessages.createdAt,
            updatedAt: nexusMessages.updatedAt,
            modelProvider: aiModels.provider,
            modelName: aiModels.modelId,
          })
          .from(nexusMessages)
          .leftJoin(aiModels, eq(nexusMessages.modelId, aiModels.id))
          .where(eq(nexusMessages.conversationId, conversationId))
          .orderBy(asc(nexusMessages.createdAt))
          .limit(clampedLimit)
          .offset(offset),
      "getMessagesByConversation"
    ) as Promise<MessageWithModel[]>;
  }

  // Simple query without JOIN - returns standard message format
  return executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMessages)
        .where(eq(nexusMessages.conversationId, conversationId))
        .orderBy(asc(nexusMessages.createdAt))
        .limit(clampedLimit)
        .offset(offset),
    "getMessagesByConversation"
  );
}

/**
 * Get a single message by ID
 */
export async function getMessageById(
  messageId: string
): Promise<SelectNexusMessage | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMessages)
        .where(eq(nexusMessages.id, messageId))
        .limit(1),
    "getMessageById"
  );

  return result[0] || null;
}

/**
 * Get message count for a conversation
 */
export async function getMessageCount(conversationId: string): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ count: countAsInt })
        .from(nexusMessages)
        .where(eq(nexusMessages.conversationId, conversationId)),
    "getMessageCount"
  );

  return result[0]?.count ?? 0;
}

/**
 * Get the last message in a conversation
 */
export async function getLastMessage(
  conversationId: string
): Promise<SelectNexusMessage | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select()
        .from(nexusMessages)
        .where(eq(nexusMessages.conversationId, conversationId))
        .orderBy(desc(nexusMessages.createdAt))
        .limit(1),
    "getLastMessage"
  );

  return result[0] || null;
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create a new message
 * Validates that the conversation exists before creating
 */
export async function createMessage(
  data: CreateMessageData
): Promise<SelectNexusMessage> {
  // Validate required fields
  if (!data.conversationId) {
    throw new Error("conversationId is required");
  }

  if (!data.role) {
    throw new Error("role is required");
  }

  const result = await executeQuery(
    (db) =>
      db
        .insert(nexusMessages)
        .values({
          id: data.id, // Will use default if undefined
          conversationId: data.conversationId,
          role: data.role,
          content: data.content || null,
          parts: data.parts ? sql`${JSON.stringify(data.parts)}::jsonb` : null,
          modelId: data.modelId || null,
          reasoningContent: data.reasoningContent || null,
          tokenUsage: data.tokenUsage ? sql`${JSON.stringify(data.tokenUsage)}::jsonb` : null,
          finishReason: data.finishReason || null,
          metadata: sql`${JSON.stringify(data.metadata || {})}::jsonb`,
        })
        .returning(),
    "createMessage"
  );

  return result[0];
}

/**
 * Create or update a message (upsert)
 * Uses atomic database upsert to prevent race conditions
 */
export async function upsertMessage(
  messageId: string,
  conversationId: string,
  data: Omit<CreateMessageData, "id" | "conversationId">
): Promise<SelectNexusMessage> {
  const result = await executeQuery(
    (db) =>
      db
        .insert(nexusMessages)
        .values({
          id: messageId,
          conversationId,
          role: data.role,
          content: data.content || null,
          parts: data.parts ? sql`${JSON.stringify(data.parts)}::jsonb` : null,
          modelId: data.modelId || null,
          reasoningContent: data.reasoningContent || null,
          tokenUsage: data.tokenUsage ? sql`${JSON.stringify(data.tokenUsage)}::jsonb` : null,
          finishReason: data.finishReason || null,
          metadata: sql`${JSON.stringify(data.metadata || {})}::jsonb`,
        })
        .onConflictDoUpdate({
          target: nexusMessages.id,
          set: {
            role: data.role,
            content: data.content || null,
            parts: data.parts ? sql`${JSON.stringify(data.parts)}::jsonb` : null,
            modelId: data.modelId || null,
            reasoningContent: data.reasoningContent || null,
            tokenUsage: data.tokenUsage ? sql`${JSON.stringify(data.tokenUsage)}::jsonb` : null,
            finishReason: data.finishReason || null,
            metadata: sql`${JSON.stringify(data.metadata || {})}::jsonb`,
            updatedAt: new Date(),
          },
        })
        .returning(),
    "upsertMessage"
  );

  return result[0];
}

/**
 * Batch create multiple messages
 * Useful for parallel prompt persistence (user + assistant placeholder)
 */
export async function batchCreateMessages(
  messages: CreateMessageData[]
): Promise<SelectNexusMessage[]> {
  if (messages.length === 0) {
    return [];
  }

  const values = messages.map((msg) => ({
    id: msg.id,
    conversationId: msg.conversationId,
    role: msg.role,
    content: msg.content || null,
    parts: msg.parts ? sql`${JSON.stringify(msg.parts)}::jsonb` : null,
    modelId: msg.modelId || null,
    reasoningContent: msg.reasoningContent || null,
    tokenUsage: msg.tokenUsage ? sql`${JSON.stringify(msg.tokenUsage)}::jsonb` : null,
    finishReason: msg.finishReason || null,
    metadata: sql`${JSON.stringify(msg.metadata || {})}::jsonb`,
  }));

  return executeQuery(
    (db) => db.insert(nexusMessages).values(values).returning(),
    "batchCreateMessages"
  );
}

/**
 * Update an existing message
 * Verifies the message belongs to the specified conversation
 */
export async function updateMessage(
  messageId: string,
  conversationId: string,
  updates: UpdateMessageData
): Promise<SelectNexusMessage | null> {
  // Build update object with explicit JSONB casting for JSONB fields
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  // Non-JSONB fields
  if (updates.content !== undefined) {
    updateData.content = updates.content;
  }
  if (updates.modelId !== undefined) {
    updateData.modelId = updates.modelId;
  }
  if (updates.reasoningContent !== undefined) {
    updateData.reasoningContent = updates.reasoningContent;
  }
  if (updates.finishReason !== undefined) {
    updateData.finishReason = updates.finishReason;
  }

  // JSONB fields with explicit casting
  if (updates.parts !== undefined) {
    updateData.parts = updates.parts ? sql`${JSON.stringify(updates.parts)}::jsonb` : null;
  }
  if (updates.tokenUsage !== undefined) {
    updateData.tokenUsage = updates.tokenUsage ? sql`${JSON.stringify(updates.tokenUsage)}::jsonb` : null;
  }
  if (updates.metadata !== undefined) {
    updateData.metadata = sql`${JSON.stringify(updates.metadata)}::jsonb`;
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(nexusMessages)
        .set(updateData)
        .where(
          and(
            eq(nexusMessages.id, messageId),
            eq(nexusMessages.conversationId, conversationId)
          )
        )
        .returning(),
    "updateMessage"
  );

  return result[0] || null;
}

/**
 * Delete a message
 * Verifies the message belongs to the specified conversation
 */
export async function deleteMessage(
  messageId: string,
  conversationId: string
): Promise<{ id: string } | null> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(nexusMessages)
        .where(
          and(
            eq(nexusMessages.id, messageId),
            eq(nexusMessages.conversationId, conversationId)
          )
        )
        .returning({ id: nexusMessages.id }),
    "deleteMessage"
  );

  return result[0] || null;
}

/**
 * Delete all messages in a conversation
 * Used when deleting a conversation (cascade handled by FK, but this is explicit)
 */
export async function deleteConversationMessages(
  conversationId: string
): Promise<number> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(nexusMessages)
        .where(eq(nexusMessages.conversationId, conversationId))
        .returning({ id: nexusMessages.id }),
    "deleteConversationMessages"
  );

  return result.length;
}

// ============================================
// Conversation Stats Operations
// ============================================

/**
 * Update conversation stats after message changes
 * Updates message_count, last_message_at, and updated_at
 */
export async function updateConversationStats(
  conversationId: string
): Promise<void> {
  // Get the message count and last message time in one query
  const stats = await executeQuery(
    (db) =>
      db
        .select({
          count: countAsInt,
          lastMessageAt: sql<Date>`max(created_at)`,
        })
        .from(nexusMessages)
        .where(eq(nexusMessages.conversationId, conversationId)),
    "getConversationStats"
  );

  const { count, lastMessageAt } = stats[0] ?? { count: 0, lastMessageAt: null };

  await executeQuery(
    (db) =>
      db
        .update(nexusConversations)
        .set({
          messageCount: count,
          lastMessageAt: lastMessageAt,
          updatedAt: new Date(),
        })
        .where(eq(nexusConversations.id, conversationId)),
    "updateConversationStats"
  );
}

/**
 * Create a message and update conversation stats sequentially
 *
 * Note: Not atomic - stats may be briefly out of sync if update fails.
 * This is acceptable for the streaming use case where stats are frequently updated.
 * If strict consistency is needed, wrap in db.transaction() at call site.
 */
export async function createMessageWithStats(
  data: CreateMessageData
): Promise<SelectNexusMessage> {
  const message = await createMessage(data);
  await updateConversationStats(data.conversationId);
  return message;
}

/**
 * Upsert a message and update conversation stats sequentially
 *
 * Note: Not atomic - stats may be briefly out of sync if update fails.
 * This is acceptable for the streaming use case where stats are frequently updated.
 * If strict consistency is needed, wrap in db.transaction() at call site.
 */
export async function upsertMessageWithStats(
  messageId: string,
  conversationId: string,
  data: Omit<CreateMessageData, "id" | "conversationId">
): Promise<SelectNexusMessage> {
  const message = await upsertMessage(messageId, conversationId, data);
  await updateConversationStats(conversationId);
  return message;
}
