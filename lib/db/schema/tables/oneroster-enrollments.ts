/**
 * OneRoster class enrollments synced from ClassLink.
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

export const onerosterEnrollments = pgTable(
  "oneroster_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcedId: text("sourced_id").notNull(),
    userSourcedId: text("user_sourced_id"),
    classSourcedId: text("class_sourced_id"),
    schoolSourcedId: text("school_sourced_id"),
    role: text("role"),
    isPrimary: boolean("is_primary"),
    beginDate: date("begin_date"),
    endDate: date("end_date"),
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
    uniqueIndex("uq_oneroster_enrollments_sourced_id").on(table.sourcedId),
    index("idx_oneroster_enrollments_class_sourced_id").on(
      table.classSourcedId
    ),
    index("idx_oneroster_enrollments_user_sourced_id").on(table.userSourcedId),
    index("idx_oneroster_enrollments_school_sourced_id").on(
      table.schoolSourcedId
    ),
    check(
      "oneroster_enrollments_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterEnrollmentRow = typeof onerosterEnrollments.$inferSelect;
export type NewOneRosterEnrollmentRow = typeof onerosterEnrollments.$inferInsert;
