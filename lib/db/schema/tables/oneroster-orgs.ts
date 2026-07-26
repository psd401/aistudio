/**
 * OneRoster organizations synced from ClassLink.
 *
 * Sourced-id references are intentionally not foreign keys so collections can
 * arrive independently. See migration 141-oneroster-core.sql.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type OneRosterStatus = "active" | "tobedeleted";

export const onerosterOrgs = pgTable(
  "oneroster_orgs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcedId: text("sourced_id").notNull(),
    name: text("name"),
    type: text("type"),
    identifier: text("identifier"),
    parentSourcedId: text("parent_sourced_id"),
    status: text("status").$type<OneRosterStatus>(),
    isActive: boolean("is_active").default(true).notNull(),
    dateLastModified: timestamp("date_last_modified", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_oneroster_orgs_sourced_id").on(table.sourcedId),
    index("idx_oneroster_orgs_parent_sourced_id").on(table.parentSourcedId),
    check(
      "oneroster_orgs_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterOrgRow = typeof onerosterOrgs.$inferSelect;
export type NewOneRosterOrgRow = typeof onerosterOrgs.$inferInsert;
