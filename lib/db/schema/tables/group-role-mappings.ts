/**
 * Group Role Mappings Table Schema
 *
 * Epic #1202 (Phase 1 / #1204) — admin-managed "members of group X get role Y".
 * The identifier is the group EMAIL (lowercased), NOT a groups.id FK: emails are
 * rename-safe and match how the Phase 0 tables key membership
 * (group_members.member_email, groups.group_email). A mapping can be created
 * before the group has synced and survives a group's deactivation/reactivation.
 * `roleId` is a real FK to roles with ON DELETE CASCADE.
 *
 * Reconciliation (lib/db/drizzle/user-roles.ts + the sync Lambda) reads these to
 * compute the set of 'group-sync' roles each user should hold.
 *
 * See migration 109-group-role-mappings.sql.
 */

import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { roles } from "./roles";

export const groupRoleMappings = pgTable(
  "group_role_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Stable group identifier, stored lowercase (uniqueness enforced on lower()). */
    groupEmail: text("group_email").notNull(),
    /** The role granted to every member of the group. Dropping the role cascades. */
    roleId: integer("role_id")
      .references(() => roles.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_group_role_mapping").on(sql`lower(${t.groupEmail})`, t.roleId),
    index("idx_group_role_mappings_group_email").on(sql`lower(${t.groupEmail})`),
    index("idx_group_role_mappings_role_id").on(t.roleId),
  ]
);

export type GroupRoleMappingRow = typeof groupRoleMappings.$inferSelect;
export type NewGroupRoleMappingRow = typeof groupRoleMappings.$inferInsert;
