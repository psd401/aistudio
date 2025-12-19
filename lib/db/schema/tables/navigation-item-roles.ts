/**
 * Navigation Item Roles Table Schema
 * Role-based navigation access control
 */

import {
  integer,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { navigationItems } from "./navigation-items";

export const navigationItemRoles = pgTable("navigation_item_roles", {
  id: serial("id").primaryKey(),
  navigationItemId: integer("navigation_item_id")
    .references(() => navigationItems.id)
    .notNull(),
  roleName: varchar("role_name", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});
