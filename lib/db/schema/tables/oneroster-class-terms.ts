/**
 * OneRoster class-to-term relationships synced from ClassLink.
 *
 * See migration 141-oneroster-core.sql.
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
import type { OneRosterStatus } from "./oneroster-orgs";

export const onerosterClassTerms = pgTable(
  "oneroster_class_terms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    classSourcedId: text("class_sourced_id").notNull(),
    termSourcedId: text("term_sourced_id").notNull(),
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
    uniqueIndex("uq_oneroster_class_terms_class_term").on(
      table.classSourcedId,
      table.termSourcedId
    ),
    index("idx_oneroster_class_terms_term_sourced_id").on(table.termSourcedId),
    check(
      "oneroster_class_terms_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterClassTermRow = typeof onerosterClassTerms.$inferSelect;
export type NewOneRosterClassTermRow = typeof onerosterClassTerms.$inferInsert;
