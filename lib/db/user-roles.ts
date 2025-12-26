import { executeQuery, executeTransaction } from './drizzle-client';
import { users, userRoles, roles } from './schema';
import { eq, inArray, sql, and } from 'drizzle-orm';
import { createLogger, generateRequestId, startTimer } from '@/lib/logger';

/**
 * Helper: Convert Error to plain object for safe logging
 * Defensive serialization to prevent logger issues with Error instances
 */
function errorToObject(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return err;
}

/**
 * Helper: Get role ID by name
 * @throws Error if role not found
 */
async function getRoleIdByName(roleName: string): Promise<number> {
  const result = await executeQuery(
    async (db) => {
      return db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.name, roleName));
    },
    'getRoleByName'
  );

  if (result.length === 0) {
    throw new Error(`Role '${roleName}' not found`);
  }

  return result[0].id;
}

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
    // Validate no duplicate role names to provide clear error message
    // (unique constraint would fail inside transaction with less clear error)
    const uniqueRoleNames = new Set(roleNames);
    if (uniqueRoleNames.size !== roleNames.length) {
      const duplicates = roleNames.filter((name, index) => roleNames.indexOf(name) !== index);
      log.error("Duplicate role names provided", { duplicates });
      throw new Error(`Duplicate role names: ${[...new Set(duplicates)].join(', ')}`);
    }

    // Get role IDs for the role names
    // NOTE: This is a separate query outside the transaction. There's a potential
    // race condition if roles are deleted between this lookup and the transaction below.
    // However, this is acceptable because:
    // 1. Roles (especially system roles) are rarely deleted
    // 2. Foreign key constraints will catch deletions and fail the transaction
    // 3. The error will be properly logged and returned to the caller
    // 4. Moving this inside the transaction wouldn't prevent the race - roles could
    //    still be deleted between lookup and insert within the same transaction
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
    // Get role ID using shared helper
    const roleId = await getRoleIdByName(roleName);

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
      error: errorToObject(error),
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
    // Get role ID using shared helper
    const roleId = await getRoleIdByName(roleName);

    // Execute transaction to remove role and update version atomically
    await executeTransaction(
      async (tx) => {
        // Remove role assignment
        await tx
          .delete(userRoles)
          .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)));

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
      error: errorToObject(error),
      userId,
      roleName,
    });
    throw error;
  }
}