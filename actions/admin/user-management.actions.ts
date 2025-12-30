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
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client"
import { eq, sql, desc, count, inArray, ilike, or, and, type SQL } from "drizzle-orm"
import { users, userRoles, roles } from "@/lib/db/schema"
import { nexusConversations } from "@/lib/db/schema/tables/nexus-conversations"
import { promptUsageEvents } from "@/lib/db/schema/tables/prompt-usage-events"
import { getDateThreshold } from "@/lib/date-utils"

// Constants
const ACTIVE_USER_THRESHOLD_DAYS = 30 // Users who signed in within this many days are considered "active"

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
function getUserStatus(lastSignInAt: Date | null): "active" | "inactive" | "pending" {
  if (!lastSignInAt) {
    return "pending" // Never signed in
  }

  const thresholdDate = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)

  if (lastSignInAt >= thresholdDate) {
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

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Calculate threshold for active users
    const thirtyDaysAgo = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)

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

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Build dynamic WHERE conditions for database-level filtering
    const conditions: SQL[] = []

    // Search filter - case-insensitive search across firstName, lastName, email
    if (filters?.search) {
      // Validate search input (prevent DoS with excessively long strings)
      const searchInput = filters.search.trim()

      // Skip query if empty string after trim (performance optimization)
      if (searchInput.length === 0) {
        // Don't add search condition, effectively showing all users
      } else if (searchInput.length > 100) {
        throw ErrorFactories.invalidInput(
          "search",
          searchInput,
          "Must be 100 characters or less"
        )
      } else {
        // Escape ILIKE wildcard characters to prevent unintended matching
        // User searching for "%" should not match all records
        const escapedInput = searchInput
          .replace(/\\/g, "\\\\") // Escape backslashes first
          .replace(/%/g, "\\%")   // Escape % wildcard
          .replace(/_/g, "\\_")   // Escape _ wildcard

        const searchTerm = `%${escapedInput}%`

        // Use Drizzle's ilike() for type safety instead of raw SQL
        conditions.push(
          or(
            ilike(users.firstName, searchTerm),
            ilike(users.lastName, searchTerm),
            ilike(users.email, searchTerm)
          )!
        )
      }
    }

    // Status filter - based on lastSignInAt
    if (filters?.status && filters.status !== "all") {
      if (filters.status === "pending") {
        conditions.push(sql`${users.lastSignInAt} IS NULL`)
      } else if (filters.status === "active") {
        const threshold = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)
        conditions.push(sql`${users.lastSignInAt} >= ${threshold}`)
      } else if (filters.status === "inactive") {
        const threshold = getDateThreshold(ACTIVE_USER_THRESHOLD_DAYS)
        conditions.push(
          sql`${users.lastSignInAt} IS NOT NULL AND ${users.lastSignInAt} < ${threshold}`
        )
      }
    }

    // Get filtered users (without role filtering - that's done on the role query)
    const usersResult = await executeQuery(
      (db) => {
        const baseSelect = {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          lastSignInAt: users.lastSignInAt,
          createdAt: users.createdAt,
        }

        // Build WHERE clause for search/status filters only
        const whereClause = conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined

        // Fetch users with search/status filters (role filtering done in role query)
        const query = db.select(baseSelect).from(users)

        return whereClause
          ? query.where(whereClause).orderBy(desc(users.createdAt))
          : query.orderBy(desc(users.createdAt))
      },
      "getUsers-list"
    )

    // Get user IDs for role query
    const userIds = usersResult.map((u) => u.id)

    if (userIds.length === 0) {
      timer({ status: "success" })
      log.info("No users found matching filters")
      return createSuccess([], "Users fetched successfully")
    }

    // Get roles for filtered users only
    const allUserRoles = await executeQuery(
      (db) =>
        db
          .select({
            userId: userRoles.userId,
            roleName: roles.name,
          })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(inArray(userRoles.userId, userIds)),
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

    // Transform results and apply role filtering if needed
    let userList: UserListItem[] = usersResult.map((user) => ({
      id: user.id,
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      email: user.email || "",
      roles: roleMap.get(user.id) || [],
      status: getUserStatus(user.lastSignInAt),
      lastSignInAt: user.lastSignInAt?.toISOString() || null,
      createdAt: user.createdAt?.toISOString() || null,
    }))

    // Filter by role if specified (done in-memory after fetching all roles once)
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

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

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

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Check if user exists
    const userExists = await executeQuery(
      (db) => db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
      "getUserActivity-checkUser"
    )

    if (userExists.length === 0) {
      throw ErrorFactories.dbRecordNotFound("users", userId)
    }

    // Parallelize activity queries for better performance
    const [conversationsResult, promptsResult, lastConversation] = await Promise.all([
      // Get nexus conversation count
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(nexusConversations)
            .where(eq(nexusConversations.userId, userId)),
        "getUserActivity-conversations"
      ),
      // Get prompt usage count
      executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(promptUsageEvents)
            .where(eq(promptUsageEvents.userId, userId)),
        "getUserActivity-prompts"
      ),
      // Get last activity (most recent conversation)
      executeQuery(
        (db) =>
          db
            .select({ lastMessageAt: nexusConversations.lastMessageAt })
            .from(nexusConversations)
            .where(eq(nexusConversations.userId, userId))
            .orderBy(desc(nexusConversations.lastMessageAt))
            .limit(1),
        "getUserActivity-lastActivity"
      ),
    ])

    const nexusConversationsCount = conversationsResult[0]?.count ?? 0
    const promptsUsed = promptsResult[0]?.count ?? 0
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

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

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

    // Update user and role assignments in a transaction
    // All validation happens inside transaction to prevent race conditions
    await executeTransaction(
      async (tx) => {
        // Update user basic info - verify user exists
        const result = await tx
          .update(users)
          .set({
            firstName: data.firstName.trim(),
            lastName: data.lastName.trim(),
          })
          .where(eq(users.id, userId))
          .returning({ id: users.id })

        // Throw if user doesn't exist
        if (result.length === 0) {
          throw ErrorFactories.dbRecordNotFound("users", userId)
        }

        // Get role IDs from role names (inside transaction to prevent race condition)
        const roleList = await tx
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(inArray(roles.name, data.roles))

        if (roleList.length !== data.roles.length) {
          throw ErrorFactories.invalidInput(
            "roles",
            data.roles,
            "One or more role names are invalid"
          )
        }

        // Prevent removing admin role from last administrator (would lock everyone out)
        const isRemovingAdmin = !data.roles.includes("administrator")
        if (isRemovingAdmin) {
          // Check if user currently has admin role
          const currentUserRoles = await tx
            .select({ roleName: roles.name })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(eq(userRoles.userId, userId))

          const isCurrentlyAdmin = currentUserRoles.some((r) => r.roleName === "administrator")

          if (isCurrentlyAdmin) {
            // User is currently an admin and we're removing it - check if they're the last one
            const adminCountResult = await tx
              .select({ count: count() })
              .from(userRoles)
              .innerJoin(roles, eq(userRoles.roleId, roles.id))
              .where(eq(roles.name, "administrator"))

            const adminCount = adminCountResult[0]?.count ?? 0
            if (adminCount <= 1) {
              throw ErrorFactories.bizInvalidState(
                "updateUser",
                "last administrator role removal attempted",
                "Cannot remove administrator role from the last administrator"
              )
            }
          }
        }

        // Delete existing role assignments
        await tx.delete(userRoles).where(eq(userRoles.userId, userId))

        // Insert new role assignments
        await tx.insert(userRoles).values(
          roleList.map((role) => ({
            userId,
            roleId: role.id,
          }))
        )
      },
      "updateUser-transaction"
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

    // Verify admin role - requireRole throws if unauthorized (validates session internally)
    await requireRole("administrator")

    // Get session to check for self-deletion (session.user.id needed)
    const session = await getServerSession()
    if (!session) {
      throw ErrorFactories.authNoSession()
    }

    // Prevent self-deletion
    // Type guard: NextAuth types session.user as {}, but it contains id at runtime
    const sessionUserId =
      session.user && typeof session.user === "object" && "id" in session.user
        ? (session.user as { id: number }).id
        : null

    if (sessionUserId === userId) {
      throw ErrorFactories.bizInvalidState(
        "deleteUser",
        "self-deletion attempted",
        "cannot delete own account"
      )
    }

    // Prevent deleting the last administrator (would lock everyone out)
    const userToDelete = await executeQuery(
      (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .innerJoin(userRoles, eq(userRoles.userId, users.id))
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(and(eq(users.id, userId), eq(roles.name, "administrator"))),
      "deleteUser-checkAdmin"
    )

    if (userToDelete.length > 0) {
      // User is an admin - check if they're the last one
      const adminCountResult = await executeQuery(
        (db) =>
          db
            .select({ count: count() })
            .from(userRoles)
            .innerJoin(roles, eq(userRoles.roleId, roles.id))
            .where(eq(roles.name, "administrator")),
        "deleteUser-adminCount"
      )

      const adminCount = adminCountResult[0]?.count ?? 0
      if (adminCount <= 1) {
        throw ErrorFactories.bizInvalidState(
          "deleteUser",
          "last administrator deletion attempted",
          "Cannot delete the last administrator"
        )
      }
    }

    // Delete user and role assignments in a transaction
    // This ensures atomicity - if the user delete fails, role delete is rolled back
    await executeTransaction(
      async (tx) => {
        // Delete user role assignments first (foreign key constraint)
        await tx.delete(userRoles).where(eq(userRoles.userId, userId))

        // Delete the user and check if it existed
        const result = await tx.delete(users).where(eq(users.id, userId)).returning()

        if (result.length === 0) {
          throw ErrorFactories.dbRecordNotFound("users", userId)
        }
      },
      "deleteUser-transaction"
    )

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
