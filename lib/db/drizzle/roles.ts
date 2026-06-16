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

import { eq, and, asc, inArray } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { roles, roleCapabilities, tools } from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";
import {
  getCapabilities,
  getRoleCapabilities,
  assignCapabilityToRole,
  removeCapabilityFromRole,
} from "@/lib/db/drizzle/capabilities";

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
//
// Issue #923: the legacy `tools`/`role_tools` tables were renamed to
// `capabilities`/`role_capabilities`. These functions keep their names and
// signatures as a compat shim during the migration window (call-site rename is
// workstream #6) and delegate to the capability accessors, which read/write the
// new tables. The capability `id` space matches the legacy tool `id` space
// (migration 079 backfills preserving ids), so downstream FK usage is unchanged.
// ============================================

/**
 * Get all capabilities assigned to a role.
 * @deprecated Prefer `getRoleCapabilities`. Retained as a compat shim (#923).
 */
export async function getRoleTools(roleId: number) {
  return getRoleCapabilities(roleId);
}

/**
 * Get all active capabilities (for the capability/tool selection UI).
 * @deprecated Prefer `getCapabilities({ activeOnly: true })`. Compat shim (#923).
 */
export async function getTools() {
  return getCapabilities({ activeOnly: true });
}

/**
 * Get legacy tool identifiers by their IDs. Returns a map of id -> identifier.
 *
 * IMPORTANT (#923): this MUST query the legacy `tools` table, NOT `capabilities`.
 * The sole caller (the navigation API) passes `navigation_items.tool_id` values,
 * and that column is an FK into `tools.id`. Migration 079 backfilled
 * `capabilities` preserving the legacy ids, but the two tables have INDEPENDENT
 * identity sequences: any `tools` row inserted after the migration (e.g. a newly
 * approved Assistant Architect) gets an id from the `tools` sequence while its
 * paired `capabilities` row gets a different id from the `capabilities` sequence.
 * Resolving a `tools.id` against `capabilities.id` would therefore return the
 * wrong identifier (or none) and silently hide the nav item. Stay on `tools`
 * until navigation_items.tool_id is migrated to capability_id (workstream #6).
 */
export async function getToolsByIds(
  toolIds: number[]
): Promise<Map<number, string>> {
  if (toolIds.length === 0) {
    return new Map();
  }

  const result = await executeQuery(
    (db) =>
      db
        .select({ id: tools.id, identifier: tools.identifier })
        .from(tools)
        .where(inArray(tools.id, toolIds)),
    "getToolsByIds"
  );

  const map = new Map<number, string>();
  for (const row of result) {
    map.set(row.id, row.identifier);
  }
  return map;
}

/**
 * Assign a capability to a role. Idempotent.
 * @deprecated Prefer `assignCapabilityToRole`. Compat shim (#923).
 */
export async function assignToolToRole(
  roleId: number,
  toolId: number
): Promise<boolean> {
  return assignCapabilityToRole(roleId, toolId);
}

/**
 * Remove a capability from a role.
 * @deprecated Prefer `removeCapabilityFromRole`. Compat shim (#923).
 */
export async function removeToolFromRole(
  roleId: number,
  toolId: number
): Promise<boolean> {
  return removeCapabilityFromRole(roleId, toolId);
}

/**
 * Set all capabilities for a role (replaces existing assignments).
 * @deprecated Compat shim (#923) — writes to role_capabilities.
 *
 * @param roleId - Role database ID
 * @param toolIds - Array of capability database IDs
 */
export async function setRoleTools(
  roleId: number,
  toolIds: number[]
): Promise<{ success: boolean }> {
  return executeTransaction(
    async (tx) => {
      await tx
        .delete(roleCapabilities)
        .where(eq(roleCapabilities.roleId, roleId));

      if (toolIds.length > 0) {
        await tx.insert(roleCapabilities).values(
          toolIds.map((capabilityId) => ({
            roleId,
            capabilityId,
          }))
        );
      }

      return { success: true };
    },
    "setRoleTools"
  );
}
