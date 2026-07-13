/**
 * Groups Table Schema
 *
 * Epic #1202 (Phase 0 / #1203) — Google Directory group sync. One row per synced
 * Google Workspace group. `groupEmail` (lowercased) is the stable identifier;
 * `source` records how the group entered the selection ('manual' pick or 'prefix'
 * match, pick wins on a tie). Groups are never hard-deleted on an API error —
 * `isActive` is flipped false when a group falls out of the selection, so
 * last-known-good membership survives a failed sync.
 *
 * See migration 106-groups.sql.
 */

import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** How a group entered the selection. A hand-picked email wins over a prefix match. */
export type GroupSource = "manual" | "prefix";

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Stable identifier, stored lowercase (uniqueness enforced on lower()). */
    groupEmail: text("group_email").notNull(),
    /** Google group display name; null until the first successful fetch. */
    name: text("name"),
    source: text("source").$type<GroupSource>().default("manual").notNull(),
    /** False when the group is no longer selected (never hard-deleted). */
    isActive: boolean("is_active").default(true).notNull(),
    /** Last successful membership fetch; null until first sync. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Last fetch error (null when the last fetch succeeded). */
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_groups_group_email").on(sql`lower(${t.groupEmail})`),
    index("idx_groups_is_active").on(t.isActive),
  ]
);

export type GroupRow = typeof groups.$inferSelect;
export type NewGroupRow = typeof groups.$inferInsert;
