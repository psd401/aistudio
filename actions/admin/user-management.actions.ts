"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { getServerSession } from "@/lib/auth/server-session"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, sql, desc, count } from "drizzle-orm"
import { users, userRoles, roles } from "@/lib/db/schema"
import { nexusConversations } from "@/lib/db/schema/tables/nexus-conversations"
import { promptUsageEvents } from "@/lib/db/schema/tables/prompt-usage-events"

// Types
export interface UserStats {
  totalUsers: number
  activeNow: number
  pendingInvites: number
  admins: number
}

export interface UserListItem {
  id: number
  firstName: string
  lastName: string
  email: string
  roles: string[]
  status: "active" | "inactive" | "pending"
  lastSignInAt: string | null
  createdAt: string | null
}

export interface UserActivity {
  nexusConversations: number
  promptsUsed: number
  lastActivity: string | null
}

export interface UserFilters {
  search?: string
  status?: "all" | "active" | "inactive" | "pending"
  role?: string
}

// Helper to determine user status based on activity
function getUserStatus(
  lastSignInAt: Date | null,
  _createdAt: Date | null
): "active" | "inactive" | "pending" {
  if (!lastSignInAt) {
    return "pending" // Never signed in
  }

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  if (lastSignInAt >= thirtyDaysAgo) {
    return "active"
  }

  return "inactive"
}

/**
 * Get user management statistics for the dashboard
 */
export async function getUserStats(): Promise<ActionState<UserStats>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserStats")
  const log = createLogger({ requestId, action: "getUserStats" })

  try {
    log.info("Fetching user stats")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }

    // Get total users count
    const totalResult = await executeQuery(
      (db) => db.select({ count: count() }).from(users),
      "getUserStats-total"
    )
    const totalUsers = totalResult[0]?.count ?? 0

    // Get active users (signed in within last 30 days)
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const activeResult = await executeQuery(
      (db) =>
        db
          .select({ count: count() })
          .from(users)
          .where(sql`${users.lastSignInAt} >= ${thirtyDaysAgo}`),
      "getUserStats-active"
    )
    const activeNow = activeResult[0]?.count ?? 0

    // Get pending users (never signed in)
    const pendingResult = await executeQuery(
      (db) =>
        db
          .select({ count: count() })
          .from(users)
          .where(sql`${users.lastSignInAt} IS NULL`),
      "getUserStats-pending"
    )
    const pendingInvites = pendingResult[0]?.count ?? 0

    // Get admin count
    const adminResult = await executeQuery(
      (db) =>
        db
          .select({ count: count() })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(eq(roles.name, "administrator")),
      "getUserStats-admins"
    )
    const admins = adminResult[0]?.count ?? 0

    timer({ status: "success" })
    log.info("User stats fetched", { totalUsers, activeNow, pendingInvites, admins })

    return createSuccess(
      { totalUsers, activeNow, pendingInvites, admins },
      "Stats fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch user stats", {
      context: "getUserStats",
      requestId,
      operation: "getUserStats",
    })
  }
}

/**
 * Get list of users with filtering support
 */
export async function getUsers(
  filters?: UserFilters
): Promise<ActionState<UserListItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUsers")
  const log = createLogger({ requestId, action: "getUsers" })

  try {
    log.info("Fetching users", { filters: sanitizeForLogging(filters) })

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }

    // Get all users with their roles
    const usersWithRoles = await executeQuery(
      (db) =>
        db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            lastSignInAt: users.lastSignInAt,
            createdAt: users.createdAt,
          })
          .from(users)
          .orderBy(desc(users.createdAt)),
      "getUsers-list"
    )

    // Get roles for all users
    const allUserRoles = await executeQuery(
      (db) =>
        db
          .select({
            userId: userRoles.userId,
            roleName: roles.name,
          })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id)),
      "getUsers-roles"
    )

    // Build role map
    const roleMap = new Map<number, string[]>()
    for (const ur of allUserRoles) {
      if (ur.userId) {
        const existing = roleMap.get(ur.userId) || []
        existing.push(ur.roleName)
        roleMap.set(ur.userId, existing)
      }
    }

    // Transform and filter results
    let userList: UserListItem[] = usersWithRoles.map((user) => ({
      id: user.id,
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      email: user.email || "",
      roles: roleMap.get(user.id) || [],
      status: getUserStatus(user.lastSignInAt, user.createdAt),
      lastSignInAt: user.lastSignInAt?.toISOString() || null,
      createdAt: user.createdAt?.toISOString() || null,
    }))

    // Apply filters
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase()
      userList = userList.filter(
        (user) =>
          user.firstName.toLowerCase().includes(searchLower) ||
          user.lastName.toLowerCase().includes(searchLower) ||
          user.email.toLowerCase().includes(searchLower)
      )
    }

    if (filters?.status && filters.status !== "all") {
      userList = userList.filter((user) => user.status === filters.status)
    }

    if (filters?.role && filters.role !== "all") {
      userList = userList.filter((user) => user.roles.includes(filters.role!))
    }

    timer({ status: "success" })
    log.info("Users fetched", { count: userList.length })

    return createSuccess(userList, "Users fetched successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch users", {
      context: "getUsers",
      requestId,
      operation: "getUsers",
    })
  }
}

/**
 * Get available roles for filtering and assignment
 */
export async function getRoles(): Promise<
  ActionState<Array<{ id: string; name: string }>>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getRoles")
  const log = createLogger({ requestId, action: "getRoles" })

  try {
    log.info("Fetching roles")

    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    const roleList = await executeQuery(
      (db) =>
        db
          .select({
            id: roles.id,
            name: roles.name,
          })
          .from(roles)
          .orderBy(roles.name),
      "getRoles"
    )

    timer({ status: "success" })
    log.info("Roles fetched", { count: roleList.length })

    return createSuccess(
      roleList.map((r) => ({ id: String(r.id), name: r.name })),
      "Roles fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch roles", {
      context: "getRoles",
      requestId,
      operation: "getRoles",
    })
  }
}

/**
 * Get user activity summary for the detail view
 */
export async function getUserActivity(
  userId: number
): Promise<ActionState<UserActivity>> {
  const requestId = generateRequestId()
  const timer = startTimer("getUserActivity")
  const log = createLogger({ requestId, action: "getUserActivity" })

  try {
    log.info("Fetching user activity", { userId })

    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    // Get nexus conversation count
    const conversationsResult = await executeQuery(
      (db) =>
        db
          .select({ count: count() })
          .from(nexusConversations)
          .where(eq(nexusConversations.userId, userId)),
      "getUserActivity-conversations"
    )
    const nexusConversationsCount = conversationsResult[0]?.count ?? 0

    // Get prompt usage count
    const promptsResult = await executeQuery(
      (db) =>
        db
          .select({ count: count() })
          .from(promptUsageEvents)
          .where(eq(promptUsageEvents.userId, userId)),
      "getUserActivity-prompts"
    )
    const promptsUsed = promptsResult[0]?.count ?? 0

    // Get last activity (most recent conversation)
    const lastConversation = await executeQuery(
      (db) =>
        db
          .select({ lastMessageAt: nexusConversations.lastMessageAt })
          .from(nexusConversations)
          .where(eq(nexusConversations.userId, userId))
          .orderBy(desc(nexusConversations.lastMessageAt))
          .limit(1),
      "getUserActivity-lastActivity"
    )
    const lastActivity = lastConversation[0]?.lastMessageAt?.toISOString() || null

    timer({ status: "success" })
    log.info("User activity fetched", {
      userId,
      nexusConversationsCount,
      promptsUsed,
    })

    return createSuccess(
      {
        nexusConversations: nexusConversationsCount,
        promptsUsed,
        lastActivity,
      },
      "Activity fetched successfully"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to fetch user activity", {
      context: "getUserActivity",
      requestId,
      operation: "getUserActivity",
    })
  }
}
