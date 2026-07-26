/**
 * OneRoster users synced from ClassLink.
 *
 * The full OneRoster 1.2 roles array is normalized into
 * `oneroster_user_roles`. See migration 141-oneroster-core.sql.
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

export const onerosterUsers = pgTable(
  "oneroster_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourcedId: text("sourced_id").notNull(),
    email: text("email"),
    username: text("username"),
    givenName: text("given_name"),
    familyName: text("family_name"),
    role: text("role"),
    enabledUser: boolean("enabled_user"),
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
    uniqueIndex("uq_oneroster_users_sourced_id").on(table.sourcedId),
    index("idx_oneroster_users_email").on(sql`lower(${table.email})`),
    check(
      "oneroster_users_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterUserRow = typeof onerosterUsers.$inferSelect;
export type NewOneRosterUserRow = typeof onerosterUsers.$inferInsert;
