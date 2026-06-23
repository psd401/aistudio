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
import { executeQuery } from "@/lib/db/drizzle-client";
import { roles, capabilities } from "@/lib/db/schema";
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
// Capability id -> identifier resolution
// ============================================

/**
 * Resolve a set of capability database IDs to their stable identifiers.
 * Returns a map of capability id -> identifier.
 *
 * Issue #928: the sole caller is the navigation API, which resolves
 * `navigation_items.capability_id` (migrated from the legacy `tools.id` FK in
 * migration 084) to a capability identifier, then runs `hasCapabilityAccess`
 * to decide whether the nav item is visible.
 */
export async function getCapabilitiesByIdsMap(
  capabilityIds: number[]
): Promise<Map<number, string>> {
  if (capabilityIds.length === 0) {
    return new Map();
  }

  const result = await executeQuery(
    (db) =>
      db
        .select({ id: capabilities.id, identifier: capabilities.identifier })
        .from(capabilities)
        .where(inArray(capabilities.id, capabilityIds)),
    "getCapabilitiesByIdsMap"
  );

  const map = new Map<number, string>();
  for (const row of result) {
    map.set(row.id, row.identifier);
  }
  return map;
}
