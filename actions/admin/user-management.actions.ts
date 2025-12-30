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
import { requireRole } from "@/lib/auth/role-helpers"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, sql, desc, count, type SQL } from "drizzle-orm"
import { users, userRoles, roles } from "@/lib/db/schema"
import { nexusConversations } from "@/lib/db/schema/tables/nexus-conversations"
import { promptUsageEvents } from "@/lib/db/schema/tables/prompt-usage-events"

// Types
export interface UserStats {
  totalUsers: number
  activeNow: number
  pendingInvites: number
  admins: number
  trends?: {
    totalUsers?: number
    activeNow?: number
    pendingInvites?: number
    admins?: number
  }
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

    // Verify admin role - requireRole throws if unauthorized
    await requireRole("administrator")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }

    // Calculate threshold for active users
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    // Parallelize all stat queries for better performance
    const [totalResult, activeResult, pendingResult, adminResult] = await Promise.all([
      // Get total users count
      executeQuery(
        (db) => db.select({ count: count() }).from(users),
        "getUserStats-total"
      ),
      // Get active users (signed in within last 30 days)
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(users)
            .where(sql`${users.lastSignInAt} >= ${thirtyDaysAgo}`),
        "getUserStats-active"
      ),
      // Get pending users (never signed in)
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(users)
            .where(sql`${users.lastSignInAt} IS NULL`),
        "getUserStats-pending"
      ),
      // Get admin count
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(eq(roles.name, "administrator")),
        "getUserStats-admins"
      ),
    ])

    const totalUsers = totalResult[0]?.count ?? 0
    const activeNow = activeResult[0]?.count ?? 0
    const pendingInvites = pendingResult[0]?.count ?? 0
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

    // Verify admin role - requireRole throws if unauthorized
    await requireRole("administrator")

    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized access attempt")
      throw ErrorFactories.authNoSession()
    }

    // Build dynamic WHERE conditions for database-level filtering
    const conditions: SQL[] = []

    // Search filter - case-insensitive search across firstName, lastName, email
    if (filters?.search) {
      // Validate search input (prevent DoS with excessively long strings)
      const searchInput = filters.search.trim()
      if (searchInput.length > 100) {
        throw ErrorFactories.invalidInput(
          "search",
          searchInput,
          "Must be 100 characters or less"
        )
      }
      if (searchInput.length < 2) {
        throw ErrorFactories.invalidInput(
          "search",
          searchInput,
          "Must be at least 2 characters"
        )
      }

      const searchTerm = `%${searchInput}%`
      conditions.push(
        sql`(
          ${users.firstName} ILIKE ${searchTerm} OR
          ${users.lastName} ILIKE ${searchTerm} OR
          ${users.email} ILIKE ${searchTerm}
        )`
      )
    }

    // Status filter - based on lastSignInAt
    if (filters?.status && filters.status !== "all") {
      if (filters.status === "pending") {
        conditions.push(sql`${users.lastSignInAt} IS NULL`)
      } else if (filters.status === "active") {
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        conditions.push(sql`${users.lastSignInAt} >= ${thirtyDaysAgo}`)
      } else if (filters.status === "inactive") {
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
        conditions.push(
          sql`${users.lastSignInAt} IS NOT NULL AND ${users.lastSignInAt} < ${thirtyDaysAgo}`
        )
      }
    }

    // Get filtered users
    const usersWithRoles = await executeQuery(
      (db) => {
        let query = db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            lastSignInAt: users.lastSignInAt,
            createdAt: users.createdAt,
          })
          .from(users)

        // Apply combined WHERE conditions
        if (conditions.length > 0) {
          query = query.where(sql`${sql.join(conditions, sql` AND `)}`) as typeof query
        }

        return query.orderBy(desc(users.createdAt))
      },
      "getUsers-list"
    )

    // Get user IDs for role filtering
    const userIds = usersWithRoles.map((u) => u.id)

    if (userIds.length === 0) {
      timer({ status: "success" })
      log.info("No users found matching filters")
      return createSuccess([], "Users fetched successfully")
    }

    // Get roles for filtered users only
    const allUserRoles = await executeQuery(
      (db) => {
        const query = db
          .select({
            userId: userRoles.userId,
            roleName: roles.name,
          })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(sql`${userRoles.userId} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`)

        return query
      },
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

    // Transform results
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

    // Apply role filter (must be done after role map is built)
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

    // Verify admin role - requireRole throws if unauthorized
    await requireRole("administrator")

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

    // Verify admin role - requireRole throws if unauthorized
    await requireRole("administrator")

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

/**
 * Update user information (name and roles)
 */
export async function updateUser(
  userId: number,
  data: {
    firstName: string
    lastName: string
    roles: string[]
  }
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateUser")
  const log = createLogger({ requestId, action: "updateUser" })

  try {
    log.info("Updating user", { userId, data: sanitizeForLogging(data) })

    // Verify admin role - requireRole throws if unauthorized
    await requireRole("administrator")

    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    // Validate input
    if (!data.firstName?.trim()) {
      throw ErrorFactories.missingRequiredField("firstName")
    }

    if (!data.lastName?.trim()) {
      throw ErrorFactories.missingRequiredField("lastName")
    }

    if (!data.roles || data.roles.length === 0) {
      throw ErrorFactories.missingRequiredField("roles")
    }

    // Update user basic info
    await executeQuery(
      (db) =>
        db
          .update(users)
          .set({
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
          })
          .where(eq(users.id, userId)),
      "updateUser"
    )

    // Get role IDs from role names
    const roleList = await executeQuery(
      (db) =>
        db
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(sql`${roles.name} IN (${sql.join(
            data.roles.map((name) => sql`${name}`),
            sql`, `
          )})`),
      "updateUser-getRoleIds"
    )

    if (roleList.length !== data.roles.length) {
      throw ErrorFactories.invalidInput(
        "roles",
        data.roles,
        "One or more role names are invalid"
      )
    }

    // Delete existing role assignments
    await executeQuery(
      (db) => db.delete(userRoles).where(eq(userRoles.userId, userId)),
      "updateUser-deleteRoles"
    )

    // Insert new role assignments
    await executeQuery(
      (db) =>
        db.insert(userRoles).values(
          roleList.map((role) => ({
            userId,
            roleId: role.id,
          }))
        ),
      "updateUser-insertRoles"
    )

    timer({ status: "success" })
    log.info("User updated successfully", { userId })

    return createSuccess(undefined, "User updated successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update user", {
      context: "updateUser",
      requestId,
      operation: "updateUser",
    })
  }
}

/**
 * Delete a user and all associated data
 */
export async function deleteUser(userId: number): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteUser")
  const log = createLogger({ requestId, action: "deleteUser" })

  try {
    log.info("Deleting user", { userId })

    // Verify admin role - requireRole throws if unauthorized
    await requireRole("administrator")

    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    // Prevent self-deletion
    if (session.user && typeof session.user === "object" && "id" in session.user && session.user.id === userId) {
      throw ErrorFactories.bizInvalidState(
        "deleteUser",
        "self-deletion attempted",
        "cannot delete own account"
      )
    }

    // Delete user role assignments first (foreign key constraint)
    await executeQuery(
      (db) => db.delete(userRoles).where(eq(userRoles.userId, userId)),
      "deleteUser-roles"
    )

    // Delete the user
    const result = await executeQuery(
      (db) => db.delete(users).where(eq(users.id, userId)).returning(),
      "deleteUser"
    )

    if (result.length === 0) {
      throw ErrorFactories.dbRecordNotFound("users", userId)
    }

    timer({ status: "success" })
    log.info("User deleted successfully", { userId })

    return createSuccess(undefined, "User deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to delete user", {
      context: "deleteUser",
      requestId,
      operation: "deleteUser",
    })
  }
}
