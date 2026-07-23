/**
 * Group Members Table Schema
 *
 * Epic #1202 (Phase 0 / #1203) — one row per (group, transitive member email).
 * Membership is keyed by EMAIL (not a users FK) so people who have never signed
 * in still sync; joins to `users` resolve lazily by lower(email). Membership is
 * transitive — nested groups are flattened during sync. Reconciliation
 * full-replaces a group's rows in a transaction, so `createdAt` is the only
 * timestamp (updated_at would always equal created_at — see migration 106).
 *
 * See migration 106-groups.sql.
 */

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { groups } from "./groups";

export const groupMembers = pgTable(
  "group_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupId: uuid("group_id")
      .references(() => groups.id, { onDelete: "cascade" })
      .notNull(),
    /** Transitive member email, lowercased. Resolves to users lazily by email. */
    memberEmail: text("member_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_group_member").on(t.groupId, sql`lower(${t.memberEmail})`),
    index("idx_group_members_email").on(sql`lower(${t.memberEmail})`),
    index("idx_group_members_group_id").on(t.groupId),
  ]
);

export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type NewGroupMemberRow = typeof groupMembers.$inferInsert;
