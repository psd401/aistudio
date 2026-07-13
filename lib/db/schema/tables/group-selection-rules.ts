/**
 * Group Selection Rules Table Schema
 *
 * Epic #1202 (Phase 0 / #1203) — admin-editable group-sync selection config.
 * Both modes coexist: 'pick' rows name an exact group email; 'prefix' rows name
 * an email prefix (client-side startsWith match). Toggling `isActive` retires a
 * rule without losing its history, so this table carries updated_at + trigger.
 *
 * See migration 106-groups.sql.
 */

import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 'pick' = exact group email; 'prefix' = email prefix (startsWith). */
export type GroupSelectionRuleType = "pick" | "prefix";

export const groupSelectionRules = pgTable(
  "group_selection_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ruleType: text("rule_type").$type<GroupSelectionRuleType>().notNull(),
    /** Pick: exact group email (lowercased). Prefix: email prefix (lowercased). */
    value: text("value").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_group_selection_rule").on(t.ruleType, sql`lower(${t.value})`)]
);

export type GroupSelectionRuleRow = typeof groupSelectionRules.$inferSelect;
export type NewGroupSelectionRuleRow = typeof groupSelectionRules.$inferInsert;
