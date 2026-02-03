/**
 * Drizzle Navigation Operations
 *
 * Navigation item CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #531 - Migrate User & Authorization queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, asc } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  navigationItems,
  navigationItemRoles,
  userRoles,
  roles,
  users,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";

// ============================================
// Types
// ============================================

export interface NavigationItemData {
  label: string;
  icon: string;
  link?: string;
  description?: string;
  type: "link" | "section" | "page";
  parentId?: number;
  toolId?: number;
  requiresRole?: string;
  position?: number;
  isActive?: boolean;
}

// ============================================
// Navigation Query Operations
// ============================================

/**
 * Get all navigation items ordered by position
 *
 * @param activeOnly - If true, only return active items
 */
export async function getNavigationItems(activeOnly: boolean = false) {
  if (activeOnly) {
    return executeQuery(
      (db) =>
        db
          .select({
            id: navigationItems.id,
            label: navigationItems.label,
            icon: navigationItems.icon,
            link: navigationItems.link,
            parentId: navigationItems.parentId,
            description: navigationItems.description,
            type: navigationItems.type,
            toolId: navigationItems.toolId,
            requiresRole: navigationItems.requiresRole,
            position: navigationItems.position,
            isActive: navigationItems.isActive,
            createdAt: navigationItems.createdAt,
          })
          .from(navigationItems)
          .where(eq(navigationItems.isActive, true))
          .orderBy(asc(navigationItems.position)),
      "getNavigationItems"
    );
  }

  return executeQuery(
    (db) =>
      db
        .select({
          id: navigationItems.id,
          label: navigationItems.label,
          icon: navigationItems.icon,
          link: navigationItems.link,
          parentId: navigationItems.parentId,
          description: navigationItems.description,
          type: navigationItems.type,
          toolId: navigationItems.toolId,
          requiresRole: navigationItems.requiresRole,
          position: navigationItems.position,
          isActive: navigationItems.isActive,
          createdAt: navigationItems.createdAt,
        })
        .from(navigationItems)
        .orderBy(asc(navigationItems.position)),
    "getNavigationItems"
  );
}

/**
 * Get navigation item by ID
 * @throws {DatabaseError} If navigation item not found
 */
export async function getNavigationItemById(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: navigationItems.id,
          label: navigationItems.label,
          icon: navigationItems.icon,
          link: navigationItems.link,
          parentId: navigationItems.parentId,
          description: navigationItems.description,
          type: navigationItems.type,
          toolId: navigationItems.toolId,
          requiresRole: navigationItems.requiresRole,
          position: navigationItems.position,
          isActive: navigationItems.isActive,
          createdAt: navigationItems.createdAt,
        })
        .from(navigationItems)
        .where(eq(navigationItems.id, id))
        .limit(1),
    "getNavigationItemById"
  );

  if (!result[0]) {
    throw ErrorFactories.dbRecordNotFound("navigation_items", id);
  }

  return result[0];
}

/**
 * Get navigation items accessible to a specific role
 * Uses navigation_item_roles junction table
 *
 * @param roleName - Role name to filter by
 */
export async function getNavigationItemsByRole(roleName: string) {
  return executeQuery(
    (db) =>
      db
        .select({
          id: navigationItems.id,
          label: navigationItems.label,
          icon: navigationItems.icon,
          link: navigationItems.link,
          parentId: navigationItems.parentId,
          description: navigationItems.description,
          type: navigationItems.type,
          toolId: navigationItems.toolId,
          requiresRole: navigationItems.requiresRole,
          position: navigationItems.position,
          isActive: navigationItems.isActive,
          createdAt: navigationItems.createdAt,
        })
        .from(navigationItems)
        .innerJoin(
          navigationItemRoles,
          eq(navigationItems.id, navigationItemRoles.navigationItemId)
        )
        .where(
          and(
            eq(navigationItemRoles.roleName, roleName),
            eq(navigationItems.isActive, true)
          )
        )
        .orderBy(asc(navigationItems.position)),
    "getNavigationItemsByRole"
  );
}

/**
 * Get navigation items accessible to a user by their Cognito sub
 * Queries through user -> user_roles -> roles -> navigation_item_roles -> navigation_items
 *
 * @param cognitoSub - User's Cognito sub identifier
 */
export async function getNavigationItemsByUser(cognitoSub: string) {
  return executeQuery(
    (db) =>
      db
        .selectDistinct({
          id: navigationItems.id,
          label: navigationItems.label,
          icon: navigationItems.icon,
          link: navigationItems.link,
          parentId: navigationItems.parentId,
          description: navigationItems.description,
          type: navigationItems.type,
          toolId: navigationItems.toolId,
          requiresRole: navigationItems.requiresRole,
          position: navigationItems.position,
          isActive: navigationItems.isActive,
          createdAt: navigationItems.createdAt,
        })
        .from(navigationItems)
        .innerJoin(
          navigationItemRoles,
          eq(navigationItems.id, navigationItemRoles.navigationItemId)
        )
        .innerJoin(roles, eq(navigationItemRoles.roleName, roles.name))
        .innerJoin(userRoles, eq(roles.id, userRoles.roleId))
        .innerJoin(users, eq(userRoles.userId, users.id))
        .where(
          and(
            eq(users.cognitoSub, cognitoSub),
            eq(navigationItems.isActive, true)
          )
        )
        .orderBy(asc(navigationItems.position)),
    "getNavigationItemsByUser"
  );
}

// ============================================
// Navigation CRUD Operations
// ============================================

/**
 * Create a new navigation item
 */
export async function createNavigationItem(data: NavigationItemData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(navigationItems)
        .values({
          label: data.label,
          icon: data.icon,
          link: data.link,
          description: data.description,
          type: data.type,
          parentId: data.parentId,
          toolId: data.toolId,
          requiresRole: data.requiresRole,
          position: data.position ?? 0,
          isActive: data.isActive ?? true,
        })
        .returning(),
    "createNavigationItem"
  );

  if (!result || result.length === 0) {
    throw ErrorFactories.dbQueryFailed(
      "INSERT into navigation_items",
      undefined,
      { technicalMessage: "Failed to create navigation item" }
    );
  }

  return result[0];
}

/**
 * Update an existing navigation item
 * Supports partial updates - only provided fields are updated
 * No-op updates (no fields provided) return existing record without error
 */
export async function updateNavigationItem(
  id: number,
  data: Partial<NavigationItemData>
) {
  // Build the update object with only provided fields
  const updateData: Record<string, unknown> = {};

  if (data.label !== undefined) updateData.label = data.label;
  if (data.icon !== undefined) updateData.icon = data.icon;
  if (data.link !== undefined) updateData.link = data.link;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.type !== undefined) updateData.type = data.type;
  if (data.parentId !== undefined) updateData.parentId = data.parentId;
  if (data.toolId !== undefined) updateData.toolId = data.toolId;
  if (data.requiresRole !== undefined) updateData.requiresRole = data.requiresRole;
  if (data.position !== undefined) updateData.position = data.position;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  // No-op update: return existing record without error
  if (Object.keys(updateData).length === 0) {
    return getNavigationItemById(id);
  }

  const result = await executeQuery(
    (db) =>
      db
        .update(navigationItems)
        .set(updateData)
        .where(eq(navigationItems.id, id))
        .returning(),
    "updateNavigationItem"
  );

  if (!result || result.length === 0) {
    throw ErrorFactories.dbRecordNotFound("navigation_items", id);
  }

  return result[0];
}

/**
 * Delete a navigation item
 */
export async function deleteNavigationItem(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .delete(navigationItems)
        .where(eq(navigationItems.id, id))
        .returning(),
    "deleteNavigationItem"
  );
  return result[0];
}

// ============================================
// Navigation Role Assignment Operations
// ============================================

/**
 * Assign roles to a navigation item
 * Replaces existing role assignments
 *
 * @param navigationItemId - Navigation item database ID
 * @param roleNames - Array of role names to assign
 */
export async function setNavigationItemRoles(
  navigationItemId: number,
  roleNames: string[]
) {
  return executeQuery(
    (db) =>
      db.transaction(async (tx) => {
        // Delete existing role assignments
        await tx
          .delete(navigationItemRoles)
          .where(eq(navigationItemRoles.navigationItemId, navigationItemId));

        // Insert new role assignments
        if (roleNames.length > 0) {
          await tx.insert(navigationItemRoles).values(
            roleNames.map((roleName) => ({
              navigationItemId,
              roleName,
            }))
          );
        }

        return { success: true };
      }),
    "setNavigationItemRoles"
  );
}

/**
 * Get roles assigned to a navigation item
 */
export async function getNavigationItemRoles(
  navigationItemId: number
): Promise<string[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ roleName: navigationItemRoles.roleName })
        .from(navigationItemRoles)
        .where(eq(navigationItemRoles.navigationItemId, navigationItemId)),
    "getNavigationItemRoles"
  );
  return result.map((r) => r.roleName);
}

/**
 * Get all navigation item roles
 * Returns a map of navigation item IDs to their required roles
 */
export async function getAllNavigationItemRoles(): Promise<
  Map<number, string[]>
> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          navigationItemId: navigationItemRoles.navigationItemId,
          roleName: navigationItemRoles.roleName,
        })
        .from(navigationItemRoles),
    "getAllNavigationItemRoles"
  );

  const rolesMap = new Map<number, string[]>();
  for (const row of result) {
    const itemId = row.navigationItemId;
    if (!rolesMap.has(itemId)) {
      rolesMap.set(itemId, []);
    }
    rolesMap.get(itemId)?.push(row.roleName);
  }
  return rolesMap;
}
