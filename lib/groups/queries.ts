/**
 * Group-sync DB accessors (Epic #1202, Phase 0).
 *
 * Read + selection-rule-write helpers backing the /admin/groups UI. The membership
 * WRITE path (reconciliation) lives in the sync Lambda, not here — the app never
 * mutates group_members. All email/prefix values are normalized (lowercased) on
 * write via the shared normalize helpers.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  groups,
  groupMembers,
  groupSelectionRules,
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
  return rows as GroupWithCount[];
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
 * Add a selection rule. Normalizes the value (lowercase + trim). If an identical
 * (type, value) rule already exists it is reactivated rather than duplicated —
 * mirrors the unique index on (rule_type, lower(value)). Runs in a transaction so
 * the exists-check and the write are atomic.
 */
export async function addSelectionRule(
  ruleType: GroupSelectionRuleType,
  rawValue: string
): Promise<GroupSelectionRuleRow> {
  const value = ruleType === "pick" ? normalizeEmail(rawValue) : normalizePrefix(rawValue);
  if (!value) {
    throw new Error("Selection rule value cannot be empty");
  }

  return executeTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(groupSelectionRules)
      .where(
        and(
          eq(groupSelectionRules.ruleType, ruleType),
          sql`lower(${groupSelectionRules.value}) = ${value}`
        )
      )
      .limit(1);

    if (existing) {
      if (existing.isActive) return existing;
      const [reactivated] = await tx
        .update(groupSelectionRules)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(groupSelectionRules.id, existing.id))
        .returning();
      return reactivated;
    }

    const [created] = await tx
      .insert(groupSelectionRules)
      .values({ ruleType, value, isActive: true })
      .returning();
    return created;
  }, "addSelectionRule");
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
