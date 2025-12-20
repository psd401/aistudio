/**
 * Drizzle Role Management Operations
 *
 * Role CRUD operations and role-tool assignments.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #531 - Migrate User & Authorization queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, asc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { roles, roleTools, tools } from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";

// ============================================
// Types
// ============================================

export interface RoleData {
  name: string;
  description?: string;
  isSystem?: boolean;
}

// ============================================
// Role Query Operations
// ============================================

/**
 * Get all roles ordered by name
 */
export async function getRoles() {
  return executeQuery(
    (db) =>
      db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
        })
        .from(roles)
        .orderBy(asc(roles.name)),
    "getRoles"
  );
}

/**
 * Get role by name
 */
export async function getRoleByName(roleName: string) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
        })
        .from(roles)
        .where(eq(roles.name, roleName))
        .limit(1),
    "getRoleByName"
  );
  return result[0];
}

/**
 * Get role by ID
 * @throws {DatabaseError} If role not found
 */
export async function getRoleById(roleId: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
        })
        .from(roles)
        .where(eq(roles.id, roleId))
        .limit(1),
    "getRoleById"
  );

  if (!result[0]) {
    throw ErrorFactories.dbRecordNotFound("roles", roleId);
  }

  return result[0];
}

// ============================================
// Role CRUD Operations
// ============================================

/**
 * Create a new role
 */
export async function createRole(roleData: RoleData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(roles)
        .values({
          name: roleData.name,
          description: roleData.description,
          isSystem: roleData.isSystem ?? false,
        })
        .returning({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
        }),
    "createRole"
  );
  return result[0];
}

/**
 * Update an existing role (non-system roles only)
 */
export async function updateRole(
  id: number,
  updates: { name?: string; description?: string }
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(roles)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(and(eq(roles.id, id), eq(roles.isSystem, false)))
        .returning({
          id: roles.id,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
        }),
    "updateRole"
  );

  if (result.length === 0) {
    throw ErrorFactories.dbRecordNotFound("roles", id, {
      technicalMessage: "Role not found or is a system role (cannot update system roles)",
    });
  }

  return result[0];
}

/**
 * Delete a role (non-system roles only)
 */
export async function deleteRole(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .delete(roles)
        .where(and(eq(roles.id, id), eq(roles.isSystem, false)))
        .returning(),
    "deleteRole"
  );

  if (result.length === 0) {
    throw ErrorFactories.dbRecordNotFound("roles", id, {
      technicalMessage: "Role not found or is a system role (cannot delete system roles)",
    });
  }

  return result[0];
}

// ============================================
// Role-Tool Assignment Operations
// ============================================

/**
 * Get all tools assigned to a role
 */
export async function getRoleTools(roleId: number) {
  return executeQuery(
    (db) =>
      db
        .select({
          id: tools.id,
          identifier: tools.identifier,
          name: tools.name,
          description: tools.description,
          isActive: tools.isActive,
          createdAt: tools.createdAt,
          updatedAt: tools.updatedAt,
        })
        .from(tools)
        .innerJoin(roleTools, eq(tools.id, roleTools.toolId))
        .where(eq(roleTools.roleId, roleId))
        .orderBy(asc(tools.name)),
    "getRoleTools"
  );
}

/**
 * Get all active tools (for tool selection UI)
 */
export async function getTools() {
  return executeQuery(
    (db) =>
      db
        .select({
          id: tools.id,
          identifier: tools.identifier,
          name: tools.name,
          description: tools.description,
          promptChainToolId: tools.promptChainToolId,
          isActive: tools.isActive,
          createdAt: tools.createdAt,
          updatedAt: tools.updatedAt,
        })
        .from(tools)
        .where(eq(tools.isActive, true))
        .orderBy(asc(tools.name)),
    "getTools"
  );
}

/**
 * Assign a tool to a role
 * Idempotent operation - succeeds even if already assigned
 *
 * @param roleId - Role database ID
 * @param toolId - Tool database ID
 * @returns Always true (conflict means already assigned)
 */
export async function assignToolToRole(
  roleId: number,
  toolId: number
): Promise<boolean> {
  await executeQuery(
    (db) =>
      db
        .insert(roleTools)
        .values({ roleId, toolId })
        .onConflictDoNothing(),
    "assignToolToRole"
  );

  return true; // Success (including if already assigned)
}

/**
 * Remove a tool from a role
 *
 * @param roleId - Role database ID
 * @param toolId - Tool database ID
 */
export async function removeToolFromRole(
  roleId: number,
  toolId: number
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(roleTools)
        .where(and(eq(roleTools.roleId, roleId), eq(roleTools.toolId, toolId)))
        .returning(),
    "removeToolFromRole"
  );

  return result.length > 0;
}

/**
 * Set all tools for a role (replaces existing assignments)
 *
 * @param roleId - Role database ID
 * @param toolIds - Array of tool database IDs
 */
export async function setRoleTools(
  roleId: number,
  toolIds: number[]
): Promise<{ success: boolean }> {
  return executeQuery(
    (db) =>
      db.transaction(async (tx) => {
        // Delete existing tool assignments
        await tx.delete(roleTools).where(eq(roleTools.roleId, roleId));

        // Insert new tool assignments
        if (toolIds.length > 0) {
          await tx.insert(roleTools).values(
            toolIds.map((toolId) => ({
              roleId,
              toolId,
            }))
          );
        }

        return { success: true };
      }),
    "setRoleTools"
  );
}
