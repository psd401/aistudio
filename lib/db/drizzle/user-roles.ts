/**
 * Drizzle User Role Operations
 *
 * User role management with transaction support for atomic operations.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #531 - Migrate User & Authorization queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/transactions
 */

import { eq, inArray, and, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { users, userRoles, roles } from "@/lib/db/schema";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { ErrorFactories } from "@/lib/error-utils";

// ============================================
// User Role Query Operations
// ============================================

/**
 * Get all roles assigned to a user by user ID
 */
export async function getUserRoles(userId: number): Promise<string[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ name: roles.name })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(userRoles.userId, userId))
        .orderBy(roles.name),
    "getUserRoles"
  );
  return result.map((r) => r.name);
}

// ============================================
// User Role Transaction Operations
// ============================================

/**
 * Update user roles - replaces all existing roles with new ones
 * Uses transaction to ensure atomicity and increments role_version
 *
 * @param userId - The user database ID
 * @param roleNames - Array of role names to assign
 * @returns Success indicator
 *
 * **Empty Roles Behavior:**
 * - Passing empty array `[]` removes all roles from user
 * - This is intentional - users can have zero roles (effectively no access)
 * - System-level checks should prevent removing the last admin role
 * - Role version is incremented to invalidate cached sessions
 *
 * @throws {DatabaseError} If any role names don't exist in database
 */
export async function updateUserRoles(
  userId: number,
  roleNames: string[]
): Promise<{ success: boolean }> {
  const requestId = generateRequestId();
  const timer = startTimer("updateUserRoles");
  const log = createLogger({ requestId, function: "updateUserRoles" });

  log.info("Updating user roles", { userId, roleNames });

  try {
    await executeQuery(
      (db) =>
        db.transaction(async (tx) => {
          // Get role IDs for the role names (skip if empty array)
          let rolesData: Array<{ id: number; name: string }> = [];

          if (roleNames.length > 0) {
            rolesData = await tx
              .select({ id: roles.id, name: roles.name })
              .from(roles)
              .where(inArray(roles.name, roleNames));

            if (rolesData.length !== roleNames.length) {
              const foundNames = rolesData.map((r) => r.name);
              const missingRoles = roleNames.filter(
                (name) => !foundNames.includes(name)
              );
              log.error("Some roles not found", { missingRoles });
              throw ErrorFactories.dbRecordNotFound(
                "roles",
                missingRoles.join(", "),
                {
                  technicalMessage: `Roles not found: ${missingRoles.join(", ")}`,
                }
              );
            }
          }

          // Delete existing roles
          await tx.delete(userRoles).where(eq(userRoles.userId, userId));

          // Insert new roles (only if we have roles to insert)
          if (rolesData.length > 0) {
            await tx.insert(userRoles).values(
              rolesData.map((r) => ({
                userId,
                roleId: r.id,
              }))
            );
          }

          // Increment role_version atomically for session cache invalidation
          await tx
            .update(users)
            .set({
              roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, userId));
        }),
      "updateUserRoles"
    );

    log.info("User roles updated successfully", {
      userId,
      roleCount: roleNames.length,
    });
    timer({ status: "success" });

    return { success: true };
  } catch (error) {
    log.error("Failed to update user roles", {
      error: error instanceof Error ? error.message : "Unknown error",
      userId,
      roleNames,
    });
    timer({ status: "error" });
    throw error;
  }
}

/**
 * Add a single role to a user without removing existing roles
 * Uses transaction with ON CONFLICT DO NOTHING for idempotency
 *
 * @param userId - The user database ID
 * @param roleName - Role name to add
 */
export async function addUserRole(
  userId: number,
  roleName: string
): Promise<{ success: boolean }> {
  const log = createLogger({ function: "addUserRole" });

  try {
    await executeQuery(
      (db) =>
        db.transaction(async (tx) => {
          // Get role ID
          const roleResult = await tx
            .select({ id: roles.id })
            .from(roles)
            .where(eq(roles.name, roleName))
            .limit(1);

          if (roleResult.length === 0) {
            throw ErrorFactories.dbRecordNotFound("roles", roleName);
          }

          const roleId = roleResult[0].id;

          // Insert role with conflict handling
          await tx
            .insert(userRoles)
            .values({
              userId,
              roleId,
            })
            .onConflictDoNothing();

          // Increment role_version for session cache invalidation
          await tx
            .update(users)
            .set({
              roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, userId));
        }),
      "addUserRole"
    );

    log.info("Role added to user", { userId, roleName });
    return { success: true };
  } catch (error) {
    log.error("Failed to add role to user", {
      error: error instanceof Error ? error.message : "Unknown error",
      userId,
      roleName,
    });
    throw error;
  }
}

/**
 * Remove a single role from a user
 * Uses transaction to ensure role_version is incremented atomically
 *
 * @param userId - The user database ID
 * @param roleName - Role name to remove
 */
export async function removeUserRole(
  userId: number,
  roleName: string
): Promise<{ success: boolean }> {
  const log = createLogger({ function: "removeUserRole" });

  try {
    await executeQuery(
      (db) =>
        db.transaction(async (tx) => {
          // Get role ID
          const roleResult = await tx
            .select({ id: roles.id })
            .from(roles)
            .where(eq(roles.name, roleName))
            .limit(1);

          if (roleResult.length === 0) {
            throw ErrorFactories.dbRecordNotFound("roles", roleName);
          }

          const roleId = roleResult[0].id;

          // Delete the user-role association
          await tx
            .delete(userRoles)
            .where(
              and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId))
            );

          // Increment role_version for session cache invalidation
          await tx
            .update(users)
            .set({
              roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, userId));
        }),
      "removeUserRole"
    );

    log.info("Role removed from user", { userId, roleName });
    return { success: true };
  } catch (error) {
    log.error("Failed to remove role from user", {
      error: error instanceof Error ? error.message : "Unknown error",
      userId,
      roleName,
    });
    throw error;
  }
}

/**
 * Update single user role - replaces all roles with a single role
 * Legacy function maintained for backward compatibility
 *
 * @param userId - The user database ID
 * @param newRoleName - Single role name to assign
 */
export async function updateUserRole(
  userId: number,
  newRoleName: string
): Promise<{ success: boolean }> {
  return updateUserRoles(userId, [newRoleName]);
}

/**
 * Assign a role to a user by role ID
 * Uses ON CONFLICT DO NOTHING for idempotency
 *
 * @param userId - The user database ID
 * @param roleId - Role database ID to assign
 */
export async function assignRoleToUser(userId: number, roleId: number) {
  return executeQuery(
    (db) =>
      db
        .insert(userRoles)
        .values({ userId, roleId })
        .onConflictDoNothing()
        .returning(),
    "assignRoleToUser"
  );
}
