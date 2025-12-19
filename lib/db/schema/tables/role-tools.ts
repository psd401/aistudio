/**
 * Role Tools Table Schema
 * Many-to-many relationship between roles and tools
 */

import { integer, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { tools } from "./tools";

export const roleTools = pgTable("role_tools", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").references(() => roles.id),
  toolId: integer("tool_id").references(() => tools.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
