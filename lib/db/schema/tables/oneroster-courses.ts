/**
 * OneRoster courses synced from ClassLink.
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

export const onerosterCourses = pgTable(
  "oneroster_courses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcedId: text("sourced_id").notNull(),
    title: text("title"),
    courseCode: text("course_code"),
    orgSourcedId: text("org_sourced_id"),
    grades: text("grades").array(),
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
    uniqueIndex("uq_oneroster_courses_sourced_id").on(table.sourcedId),
    index("idx_oneroster_courses_org_sourced_id").on(table.orgSourcedId),
    check(
      "oneroster_courses_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterCourseRow = typeof onerosterCourses.$inferSelect;
export type NewOneRosterCourseRow = typeof onerosterCourses.$inferInsert;
