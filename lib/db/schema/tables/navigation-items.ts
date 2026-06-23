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
import { capabilities } from "./capabilities";

export const navigationItems = pgTable("navigation_items", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  icon: text("icon").notNull(),
  link: text("link"),
  parentId: integer("parent_id"),
  // Renamed from tool_id (#928): the role-gated capability this nav item gates on.
  // ON DELETE SET NULL mirrors the legacy navigation_items_tool_id_fkey behavior
  // so deleting a capability (e.g. on Assistant Architect delete) nulls the
  // reference instead of blocking the delete.
  capabilityId: integer("capability_id").references(() => capabilities.id, {
    onDelete: "set null",
  }),
  requiresRole: text("requires_role"),
  position: integer("position").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  description: text("description"),
  type: navigationTypeEnum("type").default("link").notNull(),
});
