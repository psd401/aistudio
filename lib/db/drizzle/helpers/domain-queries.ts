/**
 * Domain-Specific Query Helpers
 *
 * Pre-built query helpers for common domain patterns using Drizzle relations.
 * These eliminate N+1 query patterns by using eager loading.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #543 - Add type-safe query helpers for common patterns
 *
 * @see https://orm.drizzle.team/docs/relations
 * @see /docs/database/drizzle-relational-queries.md
 */

import { eq, and, or, desc, isNull, inArray } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  users,
  userRoles,
  roles,
  roleTools,
  tools,
  nexusConversations,
  nexusMessages,
  nexusFolders,
} from "@/lib/db/schema";
import {
  calculateOffset,
  createPaginatedResult,
  countAsInt,
  type OffsetPaginationParams,
  type PaginatedResult,
} from "./pagination";
import { buildMultiColumnSearch } from "./search";
import { combineAnd, eqOrSkip, inArrayOrSkip } from "./filters";
import { buildPinnedFirstSort } from "./sorting";

// ============================================
// Types - Users
// ============================================

/**
 * User with their assigned roles
 */
export interface UserWithRoles {
  id: number;
  cognitoSub: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: Date | null;
  updatedAt: Date;
  lastSignInAt: Date | null;
  roles: Array<{
    id: number;
    name: string;
    description: string | null;
  }>;
}

/**
 * User with roles and tool access
 */
export interface UserWithRolesAndTools extends UserWithRoles {
  tools: string[];
}

/**
 * Filter options for user queries
 */
export interface UserQueryFilters {
  /** Filter by specific role name */
  roleName?: string;
  /** Filter by multiple role IDs */
  roleIds?: number[];
  /** Search across name and email */
  search?: string;
}

// ============================================
// Types - Conversations
// ============================================

/**
 * Conversation with message information
 */
export interface ConversationWithMessages {
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
  folder: {
    id: string;
    name: string;
    color: string | null;
  } | null;
  recentMessages: Array<{
    id: string;
    role: string;
    content: string | null;
    createdAt: Date | null;
  }>;
}

/**
 * Filter options for conversation queries
 */
export interface ConversationQueryFilters {
  /** Filter by folder ID (null = root level) */
  folderId?: string | null;
  /** Include archived conversations */
  includeArchived?: boolean;
  /** Filter by provider */
  provider?: string;
  /** Filter by multiple providers */
  providers?: string[];
  /** Search conversation titles */
  search?: string;
}

// ============================================
// User Query Helpers
// ============================================

/**
 * Get users with their assigned roles
 *
 * Uses a single query with JOINs to avoid N+1 problem.
 *
 * @param filters - Optional filters
 * @param pagination - Pagination parameters
 * @returns Paginated users with roles
 *
 * @example
 * ```typescript
 * const result = await getUsersWithRoles(
 *   { search: "john", roleName: "admin" },
 *   { page: 1, limit: 25 }
 * );
 * ```
 */
export async function getUsersWithRoles(
  filters: UserQueryFilters = {},
  pagination: OffsetPaginationParams = {}
): Promise<PaginatedResult<UserWithRoles>> {
  const { offset, limit } = calculateOffset(pagination);

  // Build user-level filters
  const searchCondition = filters.search
    ? buildMultiColumnSearch(
        [users.firstName, users.lastName, users.email],
        filters.search
      )
    : undefined;

  const baseConditions = combineAnd(searchCondition);

  // Get users with pagination
  const usersData = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          lastSignInAt: users.lastSignInAt,
        })
        .from(users)
        .where(baseConditions)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
    "getUsersWithRoles.users"
  );

  if (usersData.length === 0) {
    return createPaginatedResult([], pagination, 0);
  }

  // Get roles for all users in a single query
  const userIds = usersData.map((u) => u.id);
  const rolesData = await executeQuery(
    (db) =>
      db
        .select({
          userId: userRoles.userId,
          roleId: roles.id,
          roleName: roles.name,
          roleDescription: roles.description,
        })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(inArray(userRoles.userId, userIds)),
    "getUsersWithRoles.roles"
  );

  // Filter by role if specified
  let filteredUserIds = new Set<number>(userIds);
  if (filters.roleName) {
    const usersWithRole = rolesData
      .filter((r) => r.roleName === filters.roleName && r.userId !== null)
      .map((r) => r.userId as number);
    filteredUserIds = new Set(usersWithRole);
  }
  if (filters.roleIds && filters.roleIds.length > 0) {
    const usersWithRoles = rolesData
      .filter((r) => r.userId !== null && filters.roleIds!.includes(r.roleId))
      .map((r) => r.userId as number);
    filteredUserIds = new Set(usersWithRoles);
  }

  // Build role map
  const roleMap = new Map<number, Array<{ id: number; name: string; description: string | null }>>();
  for (const r of rolesData) {
    if (r.userId === null) continue;
    if (!roleMap.has(r.userId)) {
      roleMap.set(r.userId, []);
    }
    roleMap.get(r.userId)!.push({
      id: r.roleId,
      name: r.roleName,
      description: r.roleDescription,
    });
  }

  // Combine data
  const usersWithRoles: UserWithRoles[] = usersData
    .filter((u) => filteredUserIds.has(u.id))
    .map((u) => ({
      ...u,
      roles: roleMap.get(u.id) || [],
    }));

  // Get total count for pagination
  // If role filtering is applied, we need to count users with those roles
  let totalCount: number;
  if (filters.roleName || (filters.roleIds && filters.roleIds.length > 0)) {
    // Count distinct users who have the specified role(s)
    const countConditions = combineAnd(
      baseConditions,
      filters.roleName ? eq(roles.name, filters.roleName) : undefined,
      filters.roleIds && filters.roleIds.length > 0
        ? inArray(roles.id, filters.roleIds)
        : undefined
    );

    const [{ count }] = await executeQuery(
      (db) =>
        db
          .selectDistinct({ count: countAsInt })
          .from(users)
          .innerJoin(userRoles, eq(users.id, userRoles.userId))
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(countConditions),
      "getUsersWithRoles.countWithRoles"
    );
    totalCount = count;
  } else {
    // No role filtering, just count all users matching base conditions
    const [{ count }] = await executeQuery(
      (db) =>
        db
          .select({ count: countAsInt })
          .from(users)
          .where(baseConditions),
      "getUsersWithRoles.count"
    );
    totalCount = count;
  }

  return createPaginatedResult(usersWithRoles, pagination, totalCount);
}

/**
 * Get a single user with their roles and tool access
 *
 * @param userId - User database ID
 * @returns User with roles and tools, or null if not found
 *
 * @example
 * ```typescript
 * const user = await getUserWithRolesAndTools(123);
 * if (user) {
 *   console.log(user.roles, user.tools);
 * }
 * ```
 */
export async function getUserWithRolesAndTools(
  userId: number
): Promise<UserWithRolesAndTools | null> {
  // Get user
  const userData = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          lastSignInAt: users.lastSignInAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    "getUserWithRolesAndTools.user"
  );

  if (!userData[0]) {
    return null;
  }

  // Get roles
  const rolesData = await executeQuery(
    (db) =>
      db
        .select({
          roleId: roles.id,
          roleName: roles.name,
          roleDescription: roles.description,
        })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(userRoles.userId, userId)),
    "getUserWithRolesAndTools.roles"
  );

  // Get tools via role_tools
  const toolsData = await executeQuery(
    (db) =>
      db
        .selectDistinct({ identifier: tools.identifier })
        .from(userRoles)
        .innerJoin(roleTools, eq(userRoles.roleId, roleTools.roleId))
        .innerJoin(tools, eq(roleTools.toolId, tools.id))
        .where(eq(userRoles.userId, userId)),
    "getUserWithRolesAndTools.tools"
  );

  return {
    ...userData[0],
    roles: rolesData.map((r) => ({
      id: r.roleId,
      name: r.roleName,
      description: r.roleDescription,
    })),
    tools: toolsData.map((t) => t.identifier),
  };
}

// ============================================
// Conversation Query Helpers
// ============================================

/**
 * Get conversations with folder info and recent messages
 *
 * @param userId - User database ID
 * @param filters - Optional filters
 * @param pagination - Pagination parameters
 * @returns Paginated conversations with messages
 *
 * @example
 * ```typescript
 * const result = await getConversationsWithMessages(
 *   userId,
 *   { search: "project", includeArchived: false },
 *   { page: 1, limit: 20 }
 * );
 * ```
 */
export async function getConversationsWithMessages(
  userId: number,
  filters: ConversationQueryFilters = {},
  pagination: OffsetPaginationParams = {}
): Promise<PaginatedResult<ConversationWithMessages>> {
  const { offset, limit } = calculateOffset(pagination);
  const { includeArchived = false } = filters;

  // Build filter conditions
  const filterConditions = combineAnd(
    eq(nexusConversations.userId, userId),
    !includeArchived
      ? or(eq(nexusConversations.isArchived, false), isNull(nexusConversations.isArchived))
      : undefined,
    eqOrSkip(nexusConversations.folderId, filters.folderId),
    eqOrSkip(nexusConversations.provider, filters.provider),
    inArrayOrSkip(nexusConversations.provider, filters.providers),
    filters.search
      ? buildMultiColumnSearch([nexusConversations.title], filters.search)
      : undefined
  );

  // Get conversations with folder info
  const conversationsData = await executeQuery(
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
          folderId: nexusConversations.folderId,
        })
        .from(nexusConversations)
        .where(filterConditions)
        .orderBy(
          ...buildPinnedFirstSort(nexusConversations.isPinned, nexusConversations.lastMessageAt)
        )
        .limit(limit)
        .offset(offset),
    "getConversationsWithMessages.conversations"
  );

  if (conversationsData.length === 0) {
    return createPaginatedResult([], pagination, 0);
  }

  // Get folder info for conversations that have folders
  const folderIds = conversationsData
    .map((c) => c.folderId)
    .filter((id): id is string => id !== null);

  const foldersData =
    folderIds.length > 0
      ? await executeQuery(
          (db) =>
            db
              .select({
                id: nexusFolders.id,
                name: nexusFolders.name,
                color: nexusFolders.color,
              })
              .from(nexusFolders)
              .where(inArray(nexusFolders.id, folderIds)),
          "getConversationsWithMessages.folders"
        )
      : [];

  const folderMap = new Map(foldersData.map((f) => [f.id, f]));

  // Get recent messages for each conversation (last 3)
  const conversationIds = conversationsData.map((c) => c.id);
  const messagesData = await executeQuery(
    (db) =>
      db
        .select({
          conversationId: nexusMessages.conversationId,
          id: nexusMessages.id,
          role: nexusMessages.role,
          content: nexusMessages.content,
          createdAt: nexusMessages.createdAt,
        })
        .from(nexusMessages)
        .where(inArray(nexusMessages.conversationId, conversationIds))
        .orderBy(desc(nexusMessages.createdAt)),
    "getConversationsWithMessages.messages"
  );

  // Group messages by conversation (limit to 3 per conversation)
  const messageMap = new Map<
    string,
    Array<{ id: string; role: string; content: string | null; createdAt: Date | null }>
  >();
  for (const m of messagesData) {
    const existing = messageMap.get(m.conversationId) || [];
    if (existing.length < 3) {
      existing.push({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      });
      messageMap.set(m.conversationId, existing);
    }
  }

  // Combine data
  const conversationsWithMessages: ConversationWithMessages[] = conversationsData.map((c) => ({
    ...c,
    folder: c.folderId ? folderMap.get(c.folderId) || null : null,
    recentMessages: messageMap.get(c.id) || [],
  }));

  // Get total count
  const [{ count }] = await executeQuery(
    (db) =>
      db
        .select({ count: countAsInt })
        .from(nexusConversations)
        .where(filterConditions),
    "getConversationsWithMessages.count"
  );

  return createPaginatedResult(conversationsWithMessages, pagination, count);
}

/**
 * Get a single conversation with full message history
 *
 * @param conversationId - Conversation UUID
 * @param userId - User database ID (for ownership verification)
 * @param messageLimit - Maximum number of messages to return (default: 100)
 * @returns Conversation with messages, or null if not found
 *
 * @example
 * ```typescript
 * const conversation = await getConversationWithAllMessages(
 *   "abc-123",
 *   userId,
 *   50
 * );
 * ```
 */
export async function getConversationWithAllMessages(
  conversationId: string,
  userId: number,
  messageLimit: number = 100
): Promise<ConversationWithMessages | null> {
  // Get conversation with folder
  const conversationData = await executeQuery(
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
          folderId: nexusConversations.folderId,
        })
        .from(nexusConversations)
        .where(
          and(
            eq(nexusConversations.id, conversationId),
            eq(nexusConversations.userId, userId)
          )
        )
        .limit(1),
    "getConversationWithAllMessages.conversation"
  );

  if (!conversationData[0]) {
    return null;
  }

  const conversation = conversationData[0];

  // Get folder if exists
  let folder: { id: string; name: string; color: string | null } | null = null;
  if (conversation.folderId) {
    const folderData = await executeQuery(
      (db) =>
        db
          .select({
            id: nexusFolders.id,
            name: nexusFolders.name,
            color: nexusFolders.color,
          })
          .from(nexusFolders)
          .where(eq(nexusFolders.id, conversation.folderId!))
          .limit(1),
      "getConversationWithAllMessages.folder"
    );
    folder = folderData[0] || null;
  }

  // Get messages
  const messagesData = await executeQuery(
    (db) =>
      db
        .select({
          id: nexusMessages.id,
          role: nexusMessages.role,
          content: nexusMessages.content,
          createdAt: nexusMessages.createdAt,
        })
        .from(nexusMessages)
        .where(eq(nexusMessages.conversationId, conversationId))
        .orderBy(desc(nexusMessages.createdAt))
        .limit(messageLimit),
    "getConversationWithAllMessages.messages"
  );

  return {
    ...conversation,
    folder,
    recentMessages: messagesData,
  };
}
