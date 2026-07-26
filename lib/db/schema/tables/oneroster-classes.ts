/**
 * OneRoster class sections synced from ClassLink.
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

export const onerosterClasses = pgTable(
  "oneroster_classes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcedId: text("sourced_id").notNull(),
    title: text("title"),
    classCode: text("class_code"),
    classType: text("class_type"),
    location: text("location"),
    courseSourcedId: text("course_sourced_id"),
    schoolSourcedId: text("school_sourced_id"),
    grades: text("grades").array(),
    subjects: text("subjects").array(),
    periods: text("periods").array(),
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
    uniqueIndex("uq_oneroster_classes_sourced_id").on(table.sourcedId),
    index("idx_oneroster_classes_course_sourced_id").on(table.courseSourcedId),
    index("idx_oneroster_classes_school_sourced_id").on(table.schoolSourcedId),
    check(
      "oneroster_classes_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterClassRow = typeof onerosterClasses.$inferSelect;
export type NewOneRosterClassRow = typeof onerosterClasses.$inferInsert;
