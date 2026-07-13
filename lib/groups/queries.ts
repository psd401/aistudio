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

  await executeQuery(
    (db) =>
      db.execute(sql`
        INSERT INTO group_role_mappings (group_email, role_id)
        VALUES (${groupEmail}, ${roleId})
        ON CONFLICT (lower(group_email), role_id) DO NOTHING
      `),
    "addGroupRoleMapping"
  );

  // Re-read the canonical row (newly inserted OR pre-existing) with its role name.
  const [row] = await executeQuery(
    (db) =>
      db
        .select(groupRoleMappingSelection)
        .from(groupRoleMappings)
        .innerJoin(roles, eq(roles.id, groupRoleMappings.roleId))
        .where(
          and(
            eq(sql`lower(${groupRoleMappings.groupEmail})`, groupEmail),
            eq(groupRoleMappings.roleId, roleId)
          )
        )
        .limit(1),
    "addGroupRoleMappingFetch"
  );

  if (!row) {
    // The INSERT would have thrown on a bad role_id FK; a missing row here means
    // the role vanished between insert and read — surface it clearly.
    throw ErrorFactories.dbRecordNotFound("roles", String(roleId));
  }
  return row;
}

/** Delete a mapping by id. */
export async function deleteGroupRoleMapping(id: string): Promise<void> {
  await executeQuery(
    (db) => db.delete(groupRoleMappings).where(eq(groupRoleMappings.id, id)),
    "deleteGroupRoleMapping"
  );
}
