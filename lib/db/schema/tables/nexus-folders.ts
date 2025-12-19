/**
 * Nexus Folders Table Schema
 * Folder organization for conversations
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { NexusFolderSettings } from "@/types/db-types";
import { users } from "./users";

export const nexusFolders = pgTable("nexus_folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  parentId: uuid("parent_id"),
  name: varchar("name", { length: 255 }).notNull(),
  color: varchar("color", { length: 7 }).default("#6B7280"),
  icon: varchar("icon", { length: 50 }).default("folder"),
  sortOrder: integer("sort_order").default(0),
  isExpanded: boolean("is_expanded").default(false),
  settings: jsonb("settings").$type<NexusFolderSettings>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
