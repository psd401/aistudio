/**
 * Group-sync DB accessors (Epic #1202, Phase 0).
 *
 * Read + selection-rule-write helpers backing the /admin/groups UI. The membership
 * WRITE path (reconciliation) lives in the sync Lambda, not here — the app never
 * mutates group_members. All email/prefix values are normalized (lowercased) on
 * write via the shared normalize helpers.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { executeQuery, toPgRows } from "@/lib/db/drizzle-client";
import { ErrorFactories } from "@/lib/error-utils";
import {
  groups,
  groupMembers,
  groupSelectionRules,
  groupRoleMappings,
  roles,
  users,
  type GroupSelectionRuleRow,
  type GroupSelectionRuleType,
  type GroupSource,
} from "@/lib/db/schema";
import { normalizeEmail, normalizePrefix } from "./normalize";

/** A group row plus its transitive member count, for the admin browser. */
export interface GroupWithCount {
  id: string;
  groupEmail: string;
  name: string | null;
  source: GroupSource;
  isActive: boolean;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  memberCount: number;
}

/** Aggregate sync status for the admin dashboard header. */
export interface GroupSyncSummary {
  totalGroups: number;
  activeGroups: number;
  failedGroups: number;
  totalMembers: number;
  lastRunAt: Date | null;
}

/**
 * List all groups (active first, then by email) with a transitive member count.
 * LEFT JOIN so a group with zero members still appears.
 */
export async function listGroupsWithCounts(): Promise<GroupWithCount[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({
          id: groups.id,
          groupEmail: groups.groupEmail,
          name: groups.name,
          source: groups.source,
          isActive: groups.isActive,
          lastSyncedAt: groups.lastSyncedAt,
          lastSyncError: groups.lastSyncError,
          memberCount: sql<number>`count(${groupMembers.id})::int`,
        })
        .from(groups)
        .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
        .groupBy(groups.id)
        .orderBy(sql`${groups.isActive} DESC`, asc(groups.groupEmail)),
    "listGroupsWithCounts"
  );
  return rows;
}

/**
 * The lowercased emails of the ACTIVE synced groups a user belongs to — the
 * `principal.groups` match set for `group`-kind Atrium visibility grants (Epic
 * #1202 Phase 2, #1205).
 *
 * Joins the user to `group_members` on their LOWERCASED email (membership is keyed
 * by email, not a users FK; `idx_group_members_email` is on lower(email)), then to
 * `groups` restricted to `is_active` so a de-selected group grants nothing.
 * `lower()` on BOTH sides of every email comparison: storage is lowercase by
 * convention (normalizeEmail at write time) but no constraint enforces it, so the
 * join must not trust it (mirrors `reconcileUserManagedRoles`). A user with a null
 * email, no memberships, or only inactive groups yields `[]` (fails closed). The
 * result is DISTINCT and lowercased, matching the lowercased `group` grant_value.
 */
export async function listUserGroupEmailsByUserId(
  userId: number
): Promise<string[]> {
  // Defensive: a malformed/NaN id skips the query and yields no memberships.
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const rows = await executeQuery(
    (db) =>
      db
        .selectDistinct({ groupEmail: sql<string>`lower(${groups.groupEmail})` })
        .from(users)
        .innerJoin(
          groupMembers,
          eq(sql`lower(${groupMembers.memberEmail})`, sql`lower(${users.email})`)
        )
        .innerJoin(
          groups,
          and(eq(groups.id, groupMembers.groupId), eq(groups.isActive, true))
        )
        .where(eq(users.id, userId)),
    "listUserGroupEmailsByUserId"
  );
  return rows.map((r) => r.groupEmail);
}

/** A synced group reduced to what a grant picker shows/stores (#1205). */
export interface GroupPickerOption {
  /** The lowercased group email — the value stored as a `group` grant. */
  email: string;
  /** Display name (null until the first successful fetch); falls back to email in the UI. */
  name: string | null;
}

/**
 * Active synced groups for the Atrium grant editor's group picker (#1205), by
 * display name then email. Only `is_active` groups are offered — a de-selected
 * group grants nothing (mirrors `listUserGroupEmailsByUserId`'s active filter), so
 * offering it would let an author pick a grant that authorizes no one.
 */
export async function listActiveGroupsForPicker(): Promise<GroupPickerOption[]> {
  return executeQuery(
    (db) =>
      db
        .select({ email: groups.groupEmail, name: groups.name })
        .from(groups)
        .where(eq(groups.isActive, true))
        .orderBy(asc(groups.name), asc(groups.groupEmail)),
    "listActiveGroupsForPicker"
  );
}

/** Member emails for one group (alphabetical). */
export async function listGroupMemberEmails(groupId: string): Promise<string[]> {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ memberEmail: groupMembers.memberEmail })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId))
        .orderBy(asc(groupMembers.memberEmail)),
    "listGroupMemberEmails"
  );
  return rows.map((r) => r.memberEmail);
}

/** Aggregate sync status. */
export async function getGroupSyncSummary(): Promise<GroupSyncSummary> {
  const [summary] = await executeQuery(
    (db) =>
      db
        .select({
          totalGroups: sql<number>`count(*)::int`,
          activeGroups: sql<number>`count(*) filter (where ${groups.isActive})::int`,
          failedGroups: sql<number>`count(*) filter (where ${groups.lastSyncError} is not null and ${groups.isActive})::int`,
          lastRunAt: sql<Date | null>`max(${groups.lastSyncedAt})`,
        })
        .from(groups),
    "getGroupSyncSummary"
  );

  const [members] = await executeQuery(
    (db) => db.select({ total: sql<number>`count(*)::int` }).from(groupMembers),
    "getGroupSyncSummaryMembers"
  );

  return {
    totalGroups: summary?.totalGroups ?? 0,
    activeGroups: summary?.activeGroups ?? 0,
    failedGroups: summary?.failedGroups ?? 0,
    totalMembers: members?.total ?? 0,
    lastRunAt: summary?.lastRunAt ?? null,
  };
}

/** All selection rules, grouped for display (picks then prefixes, by value). */
export async function listSelectionRules(): Promise<GroupSelectionRuleRow[]> {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(groupSelectionRules)
        .orderBy(asc(groupSelectionRules.ruleType), asc(groupSelectionRules.value)),
    "listSelectionRules"
  );
}

/** Active rules only — the input to selection resolution / preview. */
export async function listActiveSelectionRules(): Promise<GroupSelectionRuleRow[]> {
  return executeQuery(
    (db) =>
      db
        .select()
        .from(groupSelectionRules)
        .where(eq(groupSelectionRules.isActive, true)),
    "listActiveSelectionRules"
  );
}

/**
 * Add a selection rule. Normalizes the value (lowercase + trim). A single atomic
 * upsert on the (rule_type, lower(value)) expression index — an identical
 * existing rule is reactivated rather than duplicated, and two concurrent
 * identical adds cannot race the unique index (same pattern as the sync
 * Lambda's upsertGroup). Raw SQL because Drizzle's onConflict builder cannot
 * target an expression index.
 */
export async function addSelectionRule(
  ruleType: GroupSelectionRuleType,
  rawValue: string
): Promise<GroupSelectionRuleRow> {
  const value = ruleType === "pick" ? normalizeEmail(rawValue) : normalizePrefix(rawValue);
  if (!value) {
    throw ErrorFactories.invalidInput("value", rawValue, "must be a non-empty group email or prefix");
  }

  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        INSERT INTO group_selection_rules (rule_type, value, is_active)
        VALUES (${ruleType}, ${value}, true)
        ON CONFLICT (rule_type, lower(value)) DO UPDATE
          SET is_active = true, updated_at = now()
        RETURNING id, rule_type, value, is_active, created_at, updated_at
      `),
    "addSelectionRule"
  );
  const [row] = toPgRows<{
    id: string;
    rule_type: GroupSelectionRuleType;
    value: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }>(result);
  return {
    id: row.id,
    ruleType: row.rule_type,
    value: row.value,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Delete a selection rule by id. */
export async function deleteSelectionRule(id: string): Promise<void> {
  await executeQuery(
    (db) => db.delete(groupSelectionRules).where(eq(groupSelectionRules.id, id)),
    "deleteSelectionRule"
  );
}

/** Toggle a selection rule active/inactive. */
export async function setSelectionRuleActive(
  id: string,
  isActive: boolean
): Promise<void> {
  await executeQuery(
    (db) =>
      db
        .update(groupSelectionRules)
        .set({ isActive, updatedAt: new Date() })
        .where(eq(groupSelectionRules.id, id)),
    "setSelectionRuleActive"
  );
}

// ---------------------------------------------------------------------------
// Group → role mappings (Epic #1202, Phase 1 / #1204)
// ---------------------------------------------------------------------------

/** A group→role mapping joined to its role name, for the admin table. */
export interface GroupRoleMappingView {
  id: string;
  groupEmail: string;
  roleId: number;
  roleName: string;
  createdAt: Date;
}

const groupRoleMappingSelection = {
  id: groupRoleMappings.id,
  groupEmail: groupRoleMappings.groupEmail,
  roleId: groupRoleMappings.roleId,
  roleName: roles.name,
  createdAt: groupRoleMappings.createdAt,
} as const;

/** List every mapping with its role name (by group email, then role name). */
export async function listGroupRoleMappings(): Promise<GroupRoleMappingView[]> {
  return executeQuery(
    (db) =>
      db
        .select(groupRoleMappingSelection)
        .from(groupRoleMappings)
        .innerJoin(roles, eq(roles.id, groupRoleMappings.roleId))
        .orderBy(asc(groupRoleMappings.groupEmail), asc(roles.name)),
    "listGroupRoleMappings"
  );
}

/**
 * Add a group→role mapping. Normalizes the group email (lowercase + trim) and
 * upserts on the (lower(group_email), role_id) expression index — a duplicate add
 * is a silent no-op rather than an error, and two concurrent identical adds
 * cannot race the unique index (mirrors addSelectionRule). Raw SQL because
 * Drizzle's onConflict builder cannot target an expression index. A bad role_id
 * fails the FK and surfaces as a DB error to the caller.
 */
export async function addGroupRoleMapping(
  rawGroupEmail: string,
  roleId: number
): Promise<GroupRoleMappingView> {
  const groupEmail = normalizeEmail(rawGroupEmail);
  if (!groupEmail) {
    throw ErrorFactories.invalidInput(
      "groupEmail",
      rawGroupEmail,
      "must be a non-empty group email"
    );
  }
  if (!Number.isInteger(roleId) || roleId <= 0) {
    throw ErrorFactories.invalidInput("roleId", roleId, "must be a positive integer role id");
  }

  // Single round trip: DO UPDATE (not DO NOTHING) so RETURNING always yields
  // the canonical row — new or pre-existing — and the joined role name comes
  // back in the same statement. No re-read, no "row vanished" race window.
  const result = await executeQuery(
    (db) =>
      db.execute(sql`
        WITH upserted AS (
          INSERT INTO group_role_mappings (group_email, role_id)
          VALUES (${groupEmail}, ${roleId})
          ON CONFLICT (lower(group_email), role_id) DO UPDATE SET updated_at = now()
          RETURNING id, group_email, role_id, created_at
        )
        SELECT u.id, u.group_email, u.role_id, r.name AS role_name, u.created_at
          FROM upserted u
          JOIN roles r ON r.id = u.role_id
      `),
    "addGroupRoleMapping"
  );
  const [row] = toPgRows<{
    id: string;
    group_email: string;
    role_id: number;
    role_name: string;
    created_at: Date;
  }>(result);
  return {
    id: row.id,
    groupEmail: row.group_email,
    roleId: row.role_id,
    roleName: row.role_name,
    createdAt: row.created_at,
  };
}

/** Delete a mapping by id. */
export async function deleteGroupRoleMapping(id: string): Promise<void> {
  await executeQuery(
    (db) => db.delete(groupRoleMappings).where(eq(groupRoleMappings.id, id)),
    "deleteGroupRoleMapping"
  );
}
