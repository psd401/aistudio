/**
 * User Roles Table Schema
 * Many-to-many relationship between users and roles
 */

import { check, integer, pgTable, serial, timestamp, unique, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { roles } from "./roles";

/**
 * How a user_roles row was granted (Epic #1202, Phase 1 / #1204).
 * 'manual'     — an admin assigned the role by hand (also the value for every
 *                pre-group-sync row). Reconciliation NEVER touches these.
 * 'group-sync' — reconciliation granted it from a group→role mapping; it is the
 *                only source reconciliation ever adds or removes.
 */
export type UserRoleSource = "manual" | "group-sync";

export const userRoles = pgTable("user_roles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id").references(() => roles.id),
  // Managed-role flag — see UserRoleSource. Defaults to 'manual' (migration 108).
  source: varchar("source", { length: 20 }).$type<UserRoleSource>().default("manual").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Composite unique constraint: prevent duplicate user-role assignments
  // Database constraint name: user_roles_user_id_role_id_key
  userRoleUnique: unique().on(table.userId, table.roleId),
  // Mirrors the inline CHECK in migration 108 so the Drizzle schema stays the
  // faithful source of truth (same convention as capabilities_source_check).
  sourceCheck: check("user_roles_source_check", sql`${table.source} IN ('manual', 'group-sync')`),
}));
