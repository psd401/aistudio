/**
 * Drizzle Prompt Library Operations
 *
 * Prompt library, tags, and usage event CRUD operations migrated from
 * RDS Data API to Drizzle ORM. All functions use executeQuery() wrapper
 * with circuit breaker and retry logic.
 *
 * **IMPORTANT - Authorization**: These are infrastructure-layer data access functions.
 * They do NOT perform authorization checks. Authorization MUST be handled at the
 * API route or server action layer before calling these functions.
 *
 * **Authorization Requirements**:
 * - Verify user owns the prompt (prompt.userId matches session.userId)
 * - Check visibility and moderation_status for public prompts
 * - Use @/lib/prompt-library/access-control helpers
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #537 - Migrate remaining database tables to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc, or, ilike, sql, inArray } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  promptLibrary,
  promptTags,
  promptLibraryTags,
  promptUsageEvents,
  users,
  nexusConversations,
} from "@/lib/db/schema";
import { createLogger, sanitizeForLogging } from "@/lib/logger";

// ============================================
// Types
// ============================================

/**
 * Visibility options for prompts
 */
export type PromptVisibility = "private" | "public";

/**
 * Moderation status for public prompts
 */
export type ModerationStatus = "pending" | "approved" | "rejected";

/**
 * Event types for usage tracking
 */
export type UsageEventType = "view" | "use" | "share";

/**
 * Data for creating a prompt
 */
export interface CreatePromptData {
  userId: number;
  title: string;
  content: string;
  description?: string | null;
  visibility?: PromptVisibility;
  sourceMessageId?: string | null;
  sourceConversationId?: string | null;
}

/**
 * Data for updating a prompt
 */
export interface UpdatePromptData {
  title?: string;
  content?: string;
  description?: string | null;
  visibility?: PromptVisibility;
}

/**
 * Prompt list item with owner name
 */
export interface PromptListItem {
  id: string;
  userId: number;
  title: string;
  preview: string;
  description: string | null;
  visibility: string;
  moderationStatus: string;
  viewCount: number;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
  ownerName: string | null;
  tags: string[];
}

/**
 * Search/filter options for prompts
 */
export interface PromptSearchOptions {
  visibility?: PromptVisibility | "all";
  tags?: string[];
  search?: string;
  userId?: number;
  filterUserId?: number;
  sort?: "recent" | "usage" | "views";
  limit?: number;
  offset?: number;
}

// ============================================
// Prompt Query Operations
// ============================================

/**
 * Get a prompt by ID
 */
export async function getPromptById(id: string): Promise<{
  id: string;
  userId: number;
  title: string;
  content: string;
  description: string | null;
  visibility: string;
  moderationStatus: string;
  moderatedBy: number | null;
  moderatedAt: Date | null;
  moderationNotes: string | null;
  sourceMessageId: string | null;
  sourceConversationId: string | null;
  viewCount: number;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  ownerName: string | null;
  tags: string[];
} | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: promptLibrary.id,
          userId: promptLibrary.userId,
          title: promptLibrary.title,
          content: promptLibrary.content,
          description: promptLibrary.description,
          visibility: promptLibrary.visibility,
          moderationStatus: promptLibrary.moderationStatus,
          moderatedBy: promptLibrary.moderatedBy,
          moderatedAt: promptLibrary.moderatedAt,
          moderationNotes: promptLibrary.moderationNotes,
          sourceMessageId: promptLibrary.sourceMessageId,
          sourceConversationId: promptLibrary.sourceConversationId,
          viewCount: promptLibrary.viewCount,
          useCount: promptLibrary.useCount,
          createdAt: promptLibrary.createdAt,
          updatedAt: promptLibrary.updatedAt,
          deletedAt: promptLibrary.deletedAt,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(promptLibrary)
        .leftJoin(users, eq(promptLibrary.userId, users.id))
        .where(and(eq(promptLibrary.id, id), sql`${promptLibrary.deletedAt} IS NULL`))
        .limit(1),
    "getPromptById"
  );

  if (!result[0]) {
    return null;
  }

  // Get tags
  const tagResult = await executeQuery(
    (db) =>
      db
        .select({ name: promptTags.name })
        .from(promptLibraryTags)
        .innerJoin(promptTags, eq(promptLibraryTags.tagId, promptTags.id))
        .where(eq(promptLibraryTags.promptId, id)),
    "getPromptTags"
  );

  const { firstName, lastName, ...prompt } = result[0];
  return {
    ...prompt,
    ownerName: firstName && lastName ? `${firstName} ${lastName}` : null,
    tags: tagResult.map((t) => t.name),
  };
}

/**
 * List prompts with filtering and pagination
 */
export async function listPrompts(
  options: PromptSearchOptions,
  currentUserId: number
): Promise<{ prompts: PromptListItem[]; total: number }> {
  const {
    visibility = "all",
    tags,
    search,
    filterUserId,
    sort = "recent",
    limit = 20,
    offset = 0,
  } = options;

  // Build where conditions
  const conditions = [sql`${promptLibrary.deletedAt} IS NULL`];

  if (visibility === "private") {
    conditions.push(eq(promptLibrary.userId, currentUserId));
  } else if (visibility === "public") {
    conditions.push(
      and(
        eq(promptLibrary.visibility, "public"),
        eq(promptLibrary.moderationStatus, "approved")
      )!
    );
  } else {
    // Show user's own prompts OR approved public prompts
    conditions.push(
      or(
        eq(promptLibrary.userId, currentUserId),
        and(
          eq(promptLibrary.visibility, "public"),
          eq(promptLibrary.moderationStatus, "approved")
        )
      )!
    );
  }

  if (filterUserId) {
    conditions.push(eq(promptLibrary.userId, filterUserId));
  }

  if (search) {
    const searchPattern = `%${search}%`;
    conditions.push(
      or(
        ilike(promptLibrary.title, searchPattern),
        ilike(promptLibrary.description, searchPattern),
        ilike(promptLibrary.content, searchPattern)
      )!
    );
  }

  // Get total count
  const countResult = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(promptLibrary)
        .where(and(...conditions)),
    "listPromptsCount"
  );
  const total = Number(countResult[0]?.count ?? 0);

  // Build order by
  let orderBy;
  if (sort === "usage") {
    orderBy = [desc(promptLibrary.useCount), desc(promptLibrary.createdAt)];
  } else if (sort === "views") {
    orderBy = [desc(promptLibrary.viewCount), desc(promptLibrary.createdAt)];
  } else {
    orderBy = [desc(promptLibrary.createdAt)];
  }

  // Get prompts
  const prompts = await executeQuery(
    (db) =>
      db
        .select({
          id: promptLibrary.id,
          userId: promptLibrary.userId,
          title: promptLibrary.title,
          preview: sql<string>`LEFT(${promptLibrary.content}, 200)`,
          description: promptLibrary.description,
          visibility: promptLibrary.visibility,
          moderationStatus: promptLibrary.moderationStatus,
          viewCount: promptLibrary.viewCount,
          useCount: promptLibrary.useCount,
          createdAt: promptLibrary.createdAt,
          updatedAt: promptLibrary.updatedAt,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(promptLibrary)
        .leftJoin(users, eq(promptLibrary.userId, users.id))
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
    "listPrompts"
  );

  // Get tags for all prompts
  const promptIds = prompts.map((p) => p.id);
  const tagsMap = new Map<string, string[]>();

  if (promptIds.length > 0) {
    const tagResults = await executeQuery(
      (db) =>
        db
          .select({
            promptId: promptLibraryTags.promptId,
            tagName: promptTags.name,
          })
          .from(promptLibraryTags)
          .innerJoin(promptTags, eq(promptLibraryTags.tagId, promptTags.id))
          .where(inArray(promptLibraryTags.promptId, promptIds)),
      "listPromptsTags"
    );

    for (const { promptId, tagName } of tagResults) {
      if (!tagsMap.has(promptId)) {
        tagsMap.set(promptId, []);
      }
      tagsMap.get(promptId)!.push(tagName);
    }
  }

  // Filter by tags if specified
  let filteredPrompts = prompts;
  if (tags && tags.length > 0) {
    filteredPrompts = prompts.filter((p) => {
      const promptTagNames = tagsMap.get(p.id) || [];
      return tags.some((t) => promptTagNames.includes(t));
    });
  }

  return {
    prompts: filteredPrompts.map((p) => ({
      id: p.id,
      userId: p.userId,
      title: p.title,
      preview: p.preview,
      description: p.description,
      visibility: p.visibility,
      moderationStatus: p.moderationStatus,
      viewCount: p.viewCount,
      useCount: p.useCount,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      ownerName:
        p.firstName && p.lastName ? `${p.firstName} ${p.lastName}` : null,
      tags: tagsMap.get(p.id) || [],
    })),
    total,
  };
}

/**
 * Get prompts pending moderation
 */
export async function getPendingPrompts(): Promise<
  {
    id: string;
    title: string;
    description: string | null;
    ownerName: string;
    createdAt: Date;
  }[]
> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: promptLibrary.id,
          title: promptLibrary.title,
          description: promptLibrary.description,
          createdAt: promptLibrary.createdAt,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(promptLibrary)
        .innerJoin(users, eq(promptLibrary.userId, users.id))
        .where(
          and(
            eq(promptLibrary.visibility, "public"),
            eq(promptLibrary.moderationStatus, "pending"),
            sql`${promptLibrary.deletedAt} IS NULL`
          )
        )
        .orderBy(promptLibrary.createdAt),
    "getPendingPrompts"
  );

  return result.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    ownerName: `${r.firstName || ""} ${r.lastName || ""}`.trim(),
    createdAt: r.createdAt,
  }));
}

// ============================================
// Prompt CRUD Operations
// ============================================

/**
 * Create a new prompt
 */
export async function createPrompt(data: CreatePromptData): Promise<{
  id: string;
  userId: number;
  title: string;
  content: string;
  description: string | null;
  visibility: string;
  moderationStatus: string;
  viewCount: number;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}> {
  const log = createLogger({ module: "drizzle-prompt-library" });

  // Private prompts are auto-approved, public need moderation
  const moderationStatus =
    data.visibility === "private" ? "approved" : "pending";

  const result = await executeQuery(
    (db) =>
      db
        .insert(promptLibrary)
        .values({
          userId: data.userId,
          title: data.title,
          content: data.content,
          description: data.description ?? null,
          visibility: data.visibility ?? "private",
          moderationStatus,
          sourceMessageId: data.sourceMessageId ?? null,
          sourceConversationId: data.sourceConversationId ?? null,
        })
        .returning(),
    "createPrompt"
  );

  if (!result[0]) {
    log.error("Failed to create prompt", { data: sanitizeForLogging(data) });
    throw new Error("Failed to create prompt");
  }

  return result[0];
}

/**
 * Update a prompt
 */
export async function updatePrompt(
  id: string,
  data: UpdatePromptData
): Promise<{
  id: string;
  userId: number;
  title: string;
  content: string;
  description: string | null;
  visibility: string;
  moderationStatus: string;
  viewCount: number;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.title !== undefined) {
    updateData.title = data.title;
  }
  if (data.content !== undefined) {
    updateData.content = data.content;
  }
  if (data.description !== undefined) {
    updateData.description = data.description;
  }
  if (data.visibility !== undefined) {
    updateData.visibility = data.visibility;
    // Reset moderation status when visibility changes
    if (data.visibility === "public") {
      updateData.moderationStatus = "pending";
      updateData.moderatedBy = null;
      updateData.moderatedAt = null;
      updateData.moderationNotes = null;
    } else {
      updateData.moderationStatus = "approved";
      updateData.moderatedBy = null;
      updateData.moderatedAt = null;
      updateData.moderationNotes = null;
    }
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(promptLibrary)
        .set(updateData)
        .where(and(eq(promptLibrary.id, id), sql`${promptLibrary.deletedAt} IS NULL`))
        .returning(),
    "updatePrompt"
  );

  return result[0] || null;
}

/**
 * Soft delete a prompt
 */
export async function deletePrompt(id: string): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .update(promptLibrary)
        .set({ deletedAt: new Date() })
        .where(and(eq(promptLibrary.id, id), sql`${promptLibrary.deletedAt} IS NULL`))
        .returning({ id: promptLibrary.id }),
    "deletePrompt"
  );

  return result.length > 0;
}

/**
 * Moderate a prompt
 */
export async function moderatePrompt(
  id: string,
  status: ModerationStatus,
  moderatorId: number,
  notes?: string
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .update(promptLibrary)
        .set({
          moderationStatus: status,
          moderatedBy: moderatorId,
          moderatedAt: new Date(),
          moderationNotes: notes ?? null,
        })
        .where(and(eq(promptLibrary.id, id), sql`${promptLibrary.deletedAt} IS NULL`))
        .returning({ id: promptLibrary.id }),
    "moderatePrompt"
  );

  return result.length > 0;
}

/**
 * Increment view count
 */
export async function incrementViewCount(id: string): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(promptLibrary)
        .set({ viewCount: sql`${promptLibrary.viewCount} + 1` })
        .where(eq(promptLibrary.id, id)),
    "incrementViewCount"
  );
}

/**
 * Increment use count
 */
export async function incrementUseCount(id: string): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(promptLibrary)
        .set({ useCount: sql`${promptLibrary.useCount} + 1` })
        .where(eq(promptLibrary.id, id)),
    "incrementUseCount"
  );
}

// ============================================
// Tag Operations
// ============================================

/**
 * Ensure tags exist and return their IDs
 */
export async function ensureTagsExist(
  tagNames: string[]
): Promise<Map<string, number>> {
  if (tagNames.length === 0) {
    return new Map();
  }

  const trimmedNames = tagNames.map((t) => t.trim());

  // Insert tags that don't exist
  for (const name of trimmedNames) {
    await executeQuery(
      (db) =>
        db
          .insert(promptTags)
          .values({ name })
          .onConflictDoNothing({ target: promptTags.name }),
      "ensureTagExists"
    );
  }

  // Get all tag IDs
  const result = await executeQuery(
    (db) =>
      db
        .select({ id: promptTags.id, name: promptTags.name })
        .from(promptTags)
        .where(inArray(promptTags.name, trimmedNames)),
    "getTagIds"
  );

  return new Map(result.map((t) => [t.name, t.id]));
}

/**
 * Set tags for a prompt (replaces existing)
 * Uses transaction to ensure atomicity
 */
export async function setPromptTags(
  promptId: string,
  tagNames: string[]
): Promise<void> {
  await executeQuery(
    (db) =>
      db.transaction(async (tx) => {
        // Delete existing tags
        await tx
          .delete(promptLibraryTags)
          .where(eq(promptLibraryTags.promptId, promptId));

        if (tagNames.length === 0) {
          return;
        }

        // Ensure tags exist and get IDs (inlined for transaction atomicity)
        const trimmedNames = tagNames.map((t) => t.trim());

        // Insert tags that don't exist (within transaction)
        for (const name of trimmedNames) {
          await tx
            .insert(promptTags)
            .values({ name })
            .onConflictDoNothing({ target: promptTags.name });
        }

        // Get all tag IDs (within transaction)
        const tagResult = await tx
          .select({ id: promptTags.id, name: promptTags.name })
          .from(promptTags)
          .where(inArray(promptTags.name, trimmedNames));

        const tagMap = new Map(tagResult.map((t) => [t.name, t.id]));

        // Insert new associations
        const values = Array.from(tagMap.values()).map((tagId) => ({
          promptId,
          tagId,
        }));

        await tx.insert(promptLibraryTags).values(values).onConflictDoNothing();
      }),
    "setPromptTags"
  );
}

// ============================================
// Usage Event Operations
// ============================================

/**
 * Track a usage event
 */
export async function trackUsageEvent(
  promptId: string,
  userId: number,
  eventType: UsageEventType,
  conversationId?: string
): Promise<void> {
  await executeQuery(
    (db) =>
      db.insert(promptUsageEvents).values({
        promptId,
        userId,
        eventType,
        conversationId: conversationId ?? null,
      }),
    "trackUsageEvent"
  );
}

/**
 * Get usage statistics for a prompt
 */
export async function getPromptUsageStats(
  promptId: string
): Promise<{
  totalViews: number;
  totalUses: number;
  recentEvents: {
    id: number;
    promptId: string;
    userId: number;
    eventType: string;
    conversationId: string | null;
    createdAt: Date | null;
  }[];
}> {
  // Get counts from prompt
  const promptResult = await executeQuery(
    (db) =>
      db
        .select({
          viewCount: promptLibrary.viewCount,
          useCount: promptLibrary.useCount,
        })
        .from(promptLibrary)
        .where(eq(promptLibrary.id, promptId))
        .limit(1),
    "getPromptCounts"
  );

  const viewCount = promptResult[0]?.viewCount ?? 0;
  const useCount = promptResult[0]?.useCount ?? 0;

  // Get recent events
  const events = await executeQuery(
    (db) =>
      db
        .select()
        .from(promptUsageEvents)
        .where(eq(promptUsageEvents.promptId, promptId))
        .orderBy(desc(promptUsageEvents.createdAt))
        .limit(50),
    "getRecentUsageEvents"
  );

  return {
    totalViews: viewCount,
    totalUses: useCount,
    recentEvents: events,
  };
}

/**
 * Create a conversation from a prompt (use prompt)
 */
export async function usePromptAndCreateConversation(
  promptId: string,
  userId: number,
  promptTitle: string,
  promptContent: string
): Promise<string> {
  const log = createLogger({ module: "drizzle-prompt-library" });

  // Create conversation
  const conversationResult = await executeQuery(
    (db) =>
      db
        .insert(nexusConversations)
        .values({
          userId,
          provider: "openai",
          title: `From prompt: ${promptTitle}`,
          metadata: {
            fromPromptId: promptId,
            initialPrompt: promptContent,
          },
        })
        .returning({ id: nexusConversations.id }),
    "createConversationFromPrompt"
  );

  if (!conversationResult[0]) {
    log.error("Failed to create conversation from prompt", { promptId, userId });
    throw new Error("Failed to create conversation from prompt");
  }

  const conversationId = conversationResult[0].id;

  // Track usage event
  await trackUsageEvent(promptId, userId, "use", conversationId);

  // Increment use count
  await incrementUseCount(promptId);

  return conversationId;
}
