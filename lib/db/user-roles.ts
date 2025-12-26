import { executeQuery, executeTransaction } from './drizzle-client';
import { users, userRoles, roles } from './schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

/**
 * Get all roles assigned to a user
 */
export async function getUserRoles(userId: number): Promise<string[]> {
  const result = await executeQuery(
    async (db) => {
      return db
        .select({ name: roles.name })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(userRoles.userId, userId))
        .orderBy(roles.name);
    },
    'getUserRoles'
  );

  return result.map(row => row.name);
}

/**
 * Update user roles - supports multiple roles
 * @param userId - The user ID
 * @param roleNames - Array of role names to assign
 */
export async function updateUserRoles(userId: number, roleNames: string[]): Promise<{ success: boolean }> {
  const requestId = generateRequestId();
  const timer = startTimer("updateUserRoles");
  const log = createLogger({ requestId, function: "updateUserRoles" });

  log.info("Updating user roles", { userId, roleNames });

  try {
    // Get role IDs for the role names
    const roleResult = await executeQuery(
      async (db) => {
        return db
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(inArray(roles.name, roleNames));
      },
      'getRolesByNames'
    );

    if (roleResult.length !== roleNames.length) {
      const foundRoles = roleResult.map(r => r.name);
      const missingRoles = roleNames.filter(name => !foundRoles.includes(name));
      log.error("Some roles not found", { missingRoles });
      throw new Error(`Roles not found: ${missingRoles.join(', ')}`);
    }

    // Execute transaction to update user roles atomically
    await executeTransaction(
      async (tx) => {
        // Step 1: Delete existing role assignments
        await tx.delete(userRoles).where(eq(userRoles.userId, userId));

        // Step 2: Insert new role assignments
        if (roleResult.length > 0) {
          await tx.insert(userRoles).values(
            roleResult.map(role => ({
              userId,
              roleId: role.id,
            }))
          );
        }

        // Step 3: Increment role_version for optimistic locking
        await tx
          .update(users)
          .set({
            roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));

        return true;
      },
      'updateUserRoles'
    );

    log.info("User roles updated successfully", {
      userId,
      roleCount: roleNames.length,
    });
    timer({ status: "success" });

    return { success: true };
  } catch (error) {
    // Defensive: convert Error to plain object before passing to logger
    function errorToObject(err: unknown) {
      if (err instanceof Error) {
        return {
          name: err.name,
          message: err.message,
          stack: err.stack,
        };
      }
      return err;
    }
    log.error("Failed to update user roles", {
      error: errorToObject(error),
      userId,
      roleNames,
    });
    timer({ status: "error" });
    throw error;
  }
}

/**
 * Add a single role to a user (without removing existing roles)
 */
export async function addUserRole(userId: number, roleName: string): Promise<{ success: boolean }> {
  const log = createLogger({ function: "addUserRole" });

  try {
    // Get role ID
    const roleResult = await executeQuery(
      async (db) => {
        return db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.name, roleName));
      },
      'getRoleByName'
    );

    if (roleResult.length === 0) {
      throw new Error(`Role '${roleName}' not found`);
    }

    const roleId = roleResult[0].id;

    // Execute transaction to add role and update version atomically
    await executeTransaction(
      async (tx) => {
        // Add role if not already assigned (upsert with ON CONFLICT DO NOTHING)
        await tx
          .insert(userRoles)
          .values({ userId, roleId })
          .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] });

        // Increment role_version for optimistic locking
        await tx
          .update(users)
          .set({
            roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));

        return true;
      },
      'addUserRole'
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
 */
export async function removeUserRole(userId: number, roleName: string): Promise<{ success: boolean }> {
  const log = createLogger({ function: "removeUserRole" });

  try {
    // Get role ID
    const roleResult = await executeQuery(
      async (db) => {
        return db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.name, roleName));
      },
      'getRoleByName'
    );

    if (roleResult.length === 0) {
      throw new Error(`Role '${roleName}' not found`);
    }

    const roleId = roleResult[0].id;

    // Execute transaction to remove role and update version atomically
    await executeTransaction(
      async (tx) => {
        // Remove role assignment
        await tx
          .delete(userRoles)
          .where(sql`${userRoles.userId} = ${userId} AND ${userRoles.roleId} = ${roleId}`);

        // Increment role_version for optimistic locking
        await tx
          .update(users)
          .set({
            roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));

        return true;
      },
      'removeUserRole'
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