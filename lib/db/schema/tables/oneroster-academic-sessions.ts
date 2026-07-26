/**
 * OneRoster academic sessions synced from ClassLink.
 *
 * See migration 141-oneroster-core.sql.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { OneRosterStatus } from "./oneroster-orgs";

export const onerosterAcademicSessions = pgTable(
  "oneroster_academic_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcedId: text("sourced_id").notNull(),
    title: text("title"),
    type: text("type"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    parentSourcedId: text("parent_sourced_id"),
    schoolYear: text("school_year"),
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
    uniqueIndex("uq_oneroster_academic_sessions_sourced_id").on(
      table.sourcedId
    ),
    index("idx_oneroster_academic_sessions_parent_sourced_id").on(
      table.parentSourcedId
    ),
    check(
      "oneroster_academic_sessions_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterAcademicSessionRow =
  typeof onerosterAcademicSessions.$inferSelect;
export type NewOneRosterAcademicSessionRow =
  typeof onerosterAcademicSessions.$inferInsert;
