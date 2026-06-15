/**
 * Role Capabilities Table Schema
 *
 * Many-to-many relationship between roles and capabilities.
 * Renamed successor to the legacy `role_tools` table.
 *
 * Issue #923 (Epic #922) — Unify Agent Platform.
 */

import { integer, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { capabilities } from "./capabilities";

export const roleCapabilities = pgTable("role_capabilities", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").references(() => roles.id),
  capabilityId: integer("capability_id").references(() => capabilities.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RoleCapability = typeof roleCapabilities.$inferSelect;
export type NewRoleCapability = typeof roleCapabilities.$inferInsert;
