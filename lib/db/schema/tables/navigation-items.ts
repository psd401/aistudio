/**
 * Navigation Items Table Schema
 * Application navigation structure
 */

import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { navigationTypeEnum } from "../enums";
import { tools } from "./tools";

export const navigationItems = pgTable("navigation_items", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  icon: text("icon").notNull(),
  link: text("link"),
  parentId: integer("parent_id"),
  toolId: integer("tool_id").references(() => tools.id),
  requiresRole: text("requires_role"),
  position: integer("position").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  description: text("description"),
  type: navigationTypeEnum("type").default("link").notNull(),
});
