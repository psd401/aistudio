/**
 * User Roles Table Schema
 * Many-to-many relationship between users and roles
 */

import { integer, pgTable, serial, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users";
import { roles } from "./roles";

export const userRoles = pgTable("user_roles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id").references(() => roles.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Composite unique constraint: prevent duplicate user-role assignments
  // Database constraint name: user_roles_user_id_role_id_key
  userRoleUnique: unique().on(table.userId, table.roleId),
}));
