/**
 * Drizzle Capability Management Operations
 *
 * Capability CRUD operations and role-capability assignments. Capabilities are
 * the role-gated UI-feature registry (renamed from the legacy `tools` table).
 *
 * This module is the source of truth for all reads of the `capabilities` /
 * `role_capabilities` tables. During the migration window (Issue #923, Epic #922)
 * the legacy `hasToolAccess()` access checks are redirected here so existing call
 * sites keep working against the new tables without a second DB round-trip.
 *
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  capabilities,
  roleCapabilities,
  roles,
  userRoles,
  users,
  type CapabilitySource,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";
import {
  createLogger,
  generateRequestId,
  startTimer,
} from "@/lib/logger";

// ============================================
// Types
// ============================================

export interface CapabilityData {
  identifier: string;
  name: string;
  description?: string | null;
  isActive?: boolean;
  source?: CapabilitySource;
  promptChainToolId?: number | null;
}

export interface UpdateCapabilityData {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

const CAPABILITY_COLUMNS = {
  id: capabilities.id,
  identifier: capabilities.identifier,
  name: capabilities.name,
  description: capabilities.description,
  isActive: capabilities.isActive,
  source: capabilities.source,
  promptChainToolId: capabilities.promptChainToolId,
  createdAt: capabilities.createdAt,
  updatedAt: capabilities.updatedAt,
} as const;

// ============================================
// Access Check Operations (compat shim targets)
// ============================================

/**
 * Check if a user has access to a capability by Cognito sub.
 *
 * This is the new-table backing query for the legacy `hasToolAccess()` access
 * check. Joins users -> user_roles -> role_capabilities -> capabilities.
 */
export async function hasCapabilityAccess(
  cognitoSub: string,
  capabilityIdentifier: string
): Promise<boolean> {
  const requestId = generateRequestId();
  const timer = startTimer("drizzle.hasCapabilityAccess");
  const log = createLogger({
    requestId,
    function: "drizzle.hasCapabilityAccess",
  });

  log.debug("Checking capability access in database", {
    cognitoSub,
    capabilityIdentifier,
  });

  try {
    const result = await executeQuery(
      (db) =>
        db
          // Selecting a constant; the access decision is result.length > 0.
          // Typed as number (postgres.js returns the literal, not a JS boolean).
          .select({ exists: sql<number>`1` })
          .from(users)
          .innerJoin(userRoles, eq(users.id, userRoles.userId))
          .innerJoin(
            roleCapabilities,
            eq(userRoles.roleId, roleCapabilities.roleId)
          )
          .innerJoin(
            capabilities,
            eq(roleCapabilities.capabilityId, capabilities.id)
          )
          .where(
            and(
              eq(users.cognitoSub, cognitoSub),
              eq(capabilities.identifier, capabilityIdentifier),
              // Disabled capabilities must not grant access. (The disable toggle
              // and AA deactivate-on-edit both rely on this — #923.)
              eq(capabilities.isActive, true)
            )
          )
          .limit(1),
      "hasCapabilityAccess"
    );

    const hasAccess = result.length > 0;

    if (hasAccess) {
      log.info("Database: Capability access granted", {
        cognitoSub,
        capabilityIdentifier,
      });
    } else {
      log.warn("Database: Capability access denied", {
        cognitoSub,
        capabilityIdentifier,
      });
    }

    timer({ status: "success", hasAccess });
    return hasAccess;
  } catch (error) {
    log.error("Database error checking capability access", {
      error: error instanceof Error ? error.message : "Unknown error",
      cognitoSub,
      capabilityIdentifier,
    });
    timer({ status: "error" });
    throw error;
  }
}

/**
 * Get all capability identifiers accessible by a user (via role assignments).
 */
export async function getUserCapabilities(
  cognitoSub: string
): Promise<string[]> {
  const result = await executeQuery(
    (db) =>
      db
        .selectDistinct({ identifier: capabilities.identifier })
        .from(users)
        .innerJoin(userRoles, eq(users.id, userRoles.userId))
        .innerJoin(
          roleCapabilities,
          eq(userRoles.roleId, roleCapabilities.roleId)
        )
        .innerJoin(
          capabilities,
          eq(roleCapabilities.capabilityId, capabilities.id)
        )
        .where(
          and(
            eq(users.cognitoSub, cognitoSub),
            // Only active capabilities count toward a user's accessible set.
            eq(capabilities.isActive, true)
          )
        ),
    "getUserCapabilities"
  );
  return result.map((r) => r.identifier);
}

// ============================================
// Capability Query Operations
// ============================================

/**
 * Get all capabilities (optionally only active), ordered by name.
 *
 * @param options.activeOnly - When true, only active capabilities are returned.
 */
export async function getCapabilities(options?: { activeOnly?: boolean }) {
  const activeOnly = options?.activeOnly ?? false;
  return executeQuery(
    (db) => {
      const query = db.select(CAPABILITY_COLUMNS).from(capabilities);
      return activeOnly
        ? query.where(eq(capabilities.isActive, true)).orderBy(asc(capabilities.name))
        : query.orderBy(asc(capabilities.name));
    },
    "getCapabilities"
  );
}

/**
 * Get a capability by its database ID.
 * @throws {DatabaseError} If not found
 */
export async function getCapabilityById(id: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select(CAPABILITY_COLUMNS)
        .from(capabilities)
        .where(eq(capabilities.id, id))
        .limit(1),
    "getCapabilityById"
  );

  if (!result[0]) {
    throw ErrorFactories.dbRecordNotFound("capabilities", id);
  }
  return result[0];
}

/**
 * Get a capability by its stable identifier, or undefined if not found.
 */
export async function getCapabilityByIdentifier(identifier: string) {
  const result = await executeQuery(
    (db) =>
      db
        .select(CAPABILITY_COLUMNS)
        .from(capabilities)
        .where(eq(capabilities.identifier, identifier))
        .limit(1),
    "getCapabilityByIdentifier"
  );
  return result[0];
}

/**
 * Get capabilities by their IDs.
 * Returns a map of capability IDs to their identifiers for efficient lookup.
 */
export async function getCapabilitiesByIds(
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
    "getCapabilitiesByIds"
  );

  const map = new Map<number, string>();
  for (const row of result) {
    map.set(row.id, row.identifier);
  }
  return map;
}

// ============================================
// Capability CRUD Operations
// ============================================

/**
 * Create a new capability.
 *
 * @param data - Capability fields. `source` defaults to "manual".
 */
export async function createCapability(data: CapabilityData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(capabilities)
        .values({
          identifier: data.identifier,
          name: data.name,
          description: data.description ?? null,
          isActive: data.isActive ?? true,
          source: data.source ?? "manual",
          promptChainToolId: data.promptChainToolId ?? null,
        })
        .returning(CAPABILITY_COLUMNS),
    "createCapability"
  );
  return result[0];
}

/**
 * Update a capability's editable fields.
 *
 * Note: `identifier` and `source` are immutable here. Callers that must enforce
 * read-only name/description for `source: 'code'` capabilities should check the
 * existing record's source before invoking this (see actions/admin layer).
 *
 * @throws {DatabaseError} If the capability does not exist
 */
export async function updateCapability(
  id: number,
  updates: UpdateCapabilityData
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(capabilities)
        .set({
          ...(updates.name !== undefined ? { name: updates.name } : {}),
          // Use ?? null so a cleared description is persisted, not skipped.
          ...(updates.description !== undefined
            ? { description: updates.description ?? null }
            : {}),
          ...(updates.isActive !== undefined
            ? { isActive: updates.isActive }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(capabilities.id, id))
        .returning(CAPABILITY_COLUMNS),
    "updateCapability"
  );

  if (result.length === 0) {
    throw ErrorFactories.dbRecordNotFound("capabilities", id);
  }
  return result[0];
}

/**
 * Upsert a capability by identifier (used by the manifest sync).
 *
 * On conflict (identifier already exists): updates name, description, source and
 * re-activates the row. This is how the manifest claims ownership of a
 * previously backfilled `source: 'manual'` row, flipping it to `source: 'code'`.
 */
export async function upsertCapabilityByIdentifier(data: CapabilityData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(capabilities)
        .values({
          identifier: data.identifier,
          name: data.name,
          description: data.description ?? null,
          isActive: data.isActive ?? true,
          source: data.source ?? "manual",
        })
        .onConflictDoUpdate({
          target: capabilities.identifier,
          set: {
            name: data.name,
            description: data.description ?? null,
            source: data.source ?? "manual",
            isActive: data.isActive ?? true,
            updatedAt: new Date(),
          },
        })
        .returning(CAPABILITY_COLUMNS),
    "upsertCapabilityByIdentifier"
  );
  return result[0];
}

/**
 * Set the active flag on a capability (used for disable + manifest deactivation).
 *
 * @throws {DatabaseError} If the capability does not exist
 */
export async function setCapabilityActive(id: number, isActive: boolean) {
  const result = await executeQuery(
    (db) =>
      db
        .update(capabilities)
        .set({ isActive, updatedAt: new Date() })
        .where(eq(capabilities.id, id))
        .returning(CAPABILITY_COLUMNS),
    "setCapabilityActive"
  );

  if (result.length === 0) {
    throw ErrorFactories.dbRecordNotFound("capabilities", id);
  }
  return result[0];
}

// ============================================
// Role-Capability Assignment Operations
// ============================================

/**
 * Get all capabilities assigned to a role.
 */
export async function getRoleCapabilities(roleId: number) {
  return executeQuery(
    (db) =>
      db
        .select(CAPABILITY_COLUMNS)
        .from(capabilities)
        .innerJoin(
          roleCapabilities,
          eq(capabilities.id, roleCapabilities.capabilityId)
        )
        .where(eq(roleCapabilities.roleId, roleId))
        .orderBy(asc(capabilities.name)),
    "getRoleCapabilities"
  );
}

/**
 * Get the role IDs a capability is assigned to.
 */
export async function getCapabilityRoleIds(
  capabilityId: number
): Promise<number[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ roleId: roleCapabilities.roleId })
        .from(roleCapabilities)
        .where(eq(roleCapabilities.capabilityId, capabilityId)),
    "getCapabilityRoleIds"
  );
  return result.map((r) => r.roleId);
}

/**
 * Assign a capability to a role. Idempotent (ON CONFLICT DO NOTHING).
 */
export async function assignCapabilityToRole(
  roleId: number,
  capabilityId: number
): Promise<boolean> {
  await executeQuery(
    (db) =>
      db
        .insert(roleCapabilities)
        .values({ roleId, capabilityId })
        .onConflictDoNothing(),
    "assignCapabilityToRole"
  );
  return true;
}

/**
 * Remove a capability from a role.
 */
export async function removeCapabilityFromRole(
  roleId: number,
  capabilityId: number
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(roleCapabilities)
        .where(
          and(
            eq(roleCapabilities.roleId, roleId),
            eq(roleCapabilities.capabilityId, capabilityId)
          )
        )
        .returning(),
    "removeCapabilityFromRole"
  );
  return result.length > 0;
}

/**
 * Resolve a role name to its ID (used by the manifest sync for default_roles).
 */
export async function getRoleIdByName(roleName: string): Promise<number | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.name, roleName))
        .limit(1),
    "getRoleIdByName"
  );
  return result[0]?.id ?? null;
}
