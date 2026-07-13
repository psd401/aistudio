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

import { eq, ne, inArray, notInArray, and, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  users,
  userRoles,
  roles,
  groups,
  groupMembers,
  groupRoleMappings,
  type UserRoleSource,
} from "@/lib/db/schema";
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
 * - Passing empty array `[]` removes all MANUAL roles from user
 * - This is intentional - users can have zero manual roles
 * - System-level checks should prevent removing the last admin role
 * - Role version is incremented to invalidate cached sessions
 *
 * **Managed (group-sync) rows are invisible to this editor (#1204):** they are
 * neither deleted nor re-stamped 'manual'. Removing a group-managed role means
 * removing the user from the mapped Google group (or deleting the mapping) —
 * a manual delete here would silently reappear on the next reconciliation, and
 * a blanket re-insert would permanently exempt it from auto-revocation.
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

          const submittedIds = rolesData.map((r) => r.id);

          // Delete only MANUAL rows no longer in the submitted set — group-sync
          // rows belong to reconciliation, not this editor.
          const deleted = await tx
            .delete(userRoles)
            .where(
              and(
                eq(userRoles.userId, userId),
                eq(userRoles.source, "manual"),
                submittedIds.length > 0
                  ? notInArray(userRoles.roleId, submittedIds)
                  : sql`TRUE`
              )
            )
            .returning({ roleId: userRoles.roleId });

          // Insert submitted roles the user lacks entirely (source defaults to
          // 'manual'). A role already held as group-sync is left as-is — the
          // admin isn't granting anything new, the group already covers it.
          let inserted: { roleId: number | null }[] = [];
          if (submittedIds.length > 0) {
            inserted = await tx
              .insert(userRoles)
              .values(submittedIds.map((roleId) => ({ userId, roleId })))
              .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] })
              .returning({ roleId: userRoles.roleId });
          }

          // Bump role_version only when a row actually changed.
          if (deleted.length > 0 || inserted.length > 0) {
            await tx
              .update(users)
              .set({
                roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
                updatedAt: new Date(),
              })
              .where(eq(users.id, userId));
          }
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

// ============================================
// Managed-Role Reconciliation (Epic #1202, Phase 1 / #1204)
// ============================================
//
// Group memberships (synced hourly in Phase 0) drive AI Studio roles. This is
// the CANONICAL per-user reconciler, called at PROVISIONING time only
// (getCurrentUserAction's session-establishment path and resolveUserId's
// create/link paths — NOT the per-request fast path, which must stay a cheap
// id lookup). Steady-state drift is owned by the hourly sync Lambda, which
// implements the SAME semantics as a set-based bulk SQL pass
// (infra/lambdas/group-sync/db.ts, reconcileManagedRoles) — it is a separate
// deploy bundle that cannot import @/lib, so the two paths share a documented
// contract rather than code (mirrors how the sync core and normalize helpers
// are duplicated across that boundary).
//
// Invariants (identical in both paths):
//   - computed = roles mapped from the user's CURRENT memberships of ACTIVE groups
//   - add computed roles the user lacks, tagged source='group-sync'
//   - remove only source='group-sync' rows no longer computed
//   - a manual (source='manual') grant of the same role is NEVER touched — it is
//     neither duplicated (unique on user_id+role_id) nor downgraded nor removed
//   - NEVER auto-revoke the system's last administrator grant (mirrors the
//     manual-path guard in actions/admin/user-management.actions.ts)
//   - bump users.role_version ONLY when rows were actually written (verified via
//     RETURNING, not the pre-write snapshot — concurrent reconciles of the same
//     user must not double-bump on a no-op)

/** One existing user_roles row, reduced to what reconciliation reasons about. */
export interface ExistingUserRole {
  roleId: number;
  source: UserRoleSource;
}

/** The reconciliation decision for a single user. */
export interface ManagedRoleDiff {
  /** role_ids to insert with source='group-sync' (ascending, deduped). */
  toAdd: number[];
  /** role_ids to delete — only ever source='group-sync' rows (ascending, deduped). */
  toRemove: number[];
  /** True when toAdd or toRemove is non-empty (drives the role_version bump). */
  changed: boolean;
}

/**
 * Pure reconciliation core — no I/O, exhaustively unit-testable. Given the roles
 * a user SHOULD hold from group mappings (`computedRoleIds`) and their current
 * user_roles rows (`existing`), decide which group-sync rows to add/remove.
 *
 * A role the user already holds (in ANY source) is never re-added, so a manual
 * grant that also happens to be mapped stays manual and survives mapping removal.
 * Only group-sync rows are eligible for removal; manual rows are invisible to the
 * remove set by construction.
 */
export function computeManagedRoleDiff(
  computedRoleIds: Iterable<number>,
  existing: ExistingUserRole[]
): ManagedRoleDiff {
  const computed = new Set<number>(computedRoleIds);
  const existingRoleIds = new Set(existing.map((r) => r.roleId));
  const managedRoleIds = new Set(
    existing.filter((r) => r.source === "group-sync").map((r) => r.roleId)
  );

  const toAdd = [...computed]
    .filter((id) => !existingRoleIds.has(id))
    .sort((a, b) => a - b);
  const toRemove = [...managedRoleIds]
    .filter((id) => !computed.has(id))
    .sort((a, b) => a - b);

  return { toAdd, toRemove, changed: toAdd.length > 0 || toRemove.length > 0 };
}

/**
 * Pure last-administrator guard decision — no I/O, unit-testable. Given the
 * roles queued for removal, the administrator role id, and how many
 * administrator rows OTHER users/rows would survive this removal, decide
 * whether the admin role must be protected from this pass.
 */
export function applyLastAdminGuard(
  toRemove: number[],
  adminRoleId: number | null,
  survivingAdminRows: number
): { toRemove: number[]; adminProtected: boolean } {
  if (
    adminRoleId === null ||
    !toRemove.includes(adminRoleId) ||
    survivingAdminRows > 0
  ) {
    return { toRemove, adminProtected: false };
  }
  return {
    toRemove: toRemove.filter((id) => id !== adminRoleId),
    adminProtected: true,
  };
}

/**
 * Reconcile a single user's managed (group-sync) roles against their current
 * group memberships, in one transaction. Adds/removes only group-sync rows and
 * bumps role_version exactly once when something changed (so live capability /
 * scope checks pick up the change on the user's next request — no re-login).
 *
 * Non-throwing on an empty email (a user with no email has no memberships to
 * reconcile). All work runs inside a single executeQuery transaction so a reader
 * never sees a half-applied role set.
 *
 * @param userId - numeric users.id
 * @param email  - the user's email (lowercased internally to match group_members)
 * @returns the applied diff (changed=false means nothing was written)
 */
export async function reconcileUserManagedRoles(
  userId: number,
  email: string
): Promise<ManagedRoleDiff> {
  const normalizedEmail = email.trim().toLowerCase();
  const log = createLogger({ function: "reconcileUserManagedRoles" });

  if (!normalizedEmail) {
    return { toAdd: [], toRemove: [], changed: false };
  }

  try {
    const diff = await executeQuery(
      (db) =>
        db.transaction(async (tx) => {
          // Roles this user SHOULD hold: mappings whose (active) group the user
          // is a member of. lower() on BOTH sides of every email comparison —
          // storage is lowercase by convention (normalizeEmail at write time),
          // but no constraint enforces it, so the join must not trust it.
          const computedRows = await tx
            .selectDistinct({ roleId: groupRoleMappings.roleId })
            .from(groupRoleMappings)
            .innerJoin(
              groups,
              and(
                eq(
                  sql`lower(${groups.groupEmail})`,
                  sql`lower(${groupRoleMappings.groupEmail})`
                ),
                eq(groups.isActive, true)
              )
            )
            .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
            .where(eq(sql`lower(${groupMembers.memberEmail})`, normalizedEmail));

          const existingRows = await tx
            .select({ roleId: userRoles.roleId, source: userRoles.source })
            .from(userRoles)
            .where(eq(userRoles.userId, userId));

          const diff = computeManagedRoleDiff(
            computedRows
              .map((r) => r.roleId)
              .filter((id): id is number => id !== null),
            existingRows
              .filter((r): r is { roleId: number; source: UserRoleSource } => r.roleId !== null)
              .map((r) => ({ roleId: r.roleId, source: r.source }))
          );

          if (!diff.changed) return diff;

          // Last-administrator lockout guard: an automated revocation must never
          // zero out the system's administrators (there would be no in-app
          // recovery — every admin surface, including the mapping UI itself, is
          // admin-gated). Mirrors actions/admin/user-management.actions.ts.
          let toRemove = diff.toRemove;
          if (toRemove.length > 0) {
            const [adminRole] = await tx
              .select({ id: roles.id })
              .from(roles)
              .where(eq(roles.name, "administrator"))
              .limit(1);
            if (adminRole && toRemove.includes(adminRole.id)) {
              const [remaining] = await tx
                .select({ count: sql<number>`count(*)::int` })
                .from(userRoles)
                .where(
                  and(
                    eq(userRoles.roleId, adminRole.id),
                    ne(userRoles.userId, userId)
                  )
                );
              const guarded = applyLastAdminGuard(
                toRemove,
                adminRole.id,
                remaining?.count ?? 0
              );
              toRemove = guarded.toRemove;
              if (guarded.adminProtected) {
                log.warn(
                  "Refusing to auto-revoke the last administrator via group-sync",
                  { userId }
                );
              }
            }
          }

          let inserted: { roleId: number | null }[] = [];
          if (diff.toAdd.length > 0) {
            inserted = await tx
              .insert(userRoles)
              .values(
                diff.toAdd.map((roleId) => ({
                  userId,
                  roleId,
                  source: "group-sync" as const,
                }))
              )
              // Race with a concurrent grant of the same role: keep whatever is
              // already there rather than erroring on the unique constraint.
              .onConflictDoNothing({ target: [userRoles.userId, userRoles.roleId] })
              .returning({ roleId: userRoles.roleId });
          }

          let removed: { roleId: number | null }[] = [];
          if (toRemove.length > 0) {
            removed = await tx
              .delete(userRoles)
              .where(
                and(
                  eq(userRoles.userId, userId),
                  // Belt-and-braces: only group-sync rows are ever removed, so a
                  // manual grant can never be deleted even if role_ids overlap.
                  eq(userRoles.source, "group-sync"),
                  inArray(userRoles.roleId, toRemove)
                )
              )
              .returning({ roleId: userRoles.roleId });
          }

          // Bump role_version only when a row was ACTUALLY written — a
          // concurrent reconcile that lost every race (conflict-skipped insert,
          // empty-match delete) must be a true no-op (no churn).
          const applied = inserted.length > 0 || removed.length > 0;
          if (applied) {
            await tx
              .update(users)
              .set({
                roleVersion: sql`COALESCE(${users.roleVersion}, 0) + 1`,
                updatedAt: new Date(),
              })
              .where(eq(users.id, userId));
          }

          return {
            toAdd: inserted.map((r) => r.roleId).filter((id): id is number => id !== null),
            toRemove: removed.map((r) => r.roleId).filter((id): id is number => id !== null),
            changed: applied,
          };
        }),
      "reconcileUserManagedRoles"
    );

    if (diff.changed) {
      log.info("Reconciled managed roles", {
        userId,
        added: diff.toAdd,
        removed: diff.toRemove,
      });
    }
    return diff;
  } catch (error) {
    log.error("Failed to reconcile managed roles", {
      error: error instanceof Error ? error.message : "Unknown error",
      userId,
    });
    throw error;
  }
}
