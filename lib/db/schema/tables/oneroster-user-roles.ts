/**
 * OneRoster 1.2 user roles normalized from each user's roles array.
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

export const onerosterUserRoles = pgTable(
  "oneroster_user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userSourcedId: text("user_sourced_id").notNull(),
    role: text("role").notNull(),
    roleType: text("role_type").notNull(),
    orgSourcedId: text("org_sourced_id"),
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
    uniqueIndex("uq_oneroster_user_roles_tuple").on(
      table.userSourcedId,
      table.role,
      table.roleType,
      sql`coalesce(${table.orgSourcedId}, '')`
    ),
    index("idx_oneroster_user_roles_org_sourced_id").on(table.orgSourcedId),
    check(
      "oneroster_user_roles_status_check",
      sql`${table.status} IN ('active', 'tobedeleted')`
    ),
  ]
);

export type OneRosterUserRoleRow = typeof onerosterUserRoles.$inferSelect;
export type NewOneRosterUserRoleRow = typeof onerosterUserRoles.$inferInsert;
