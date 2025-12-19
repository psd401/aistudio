/**
 * Nexus User Preferences Table Schema
 * User-specific UI and behavior preferences
 */

import {
  integer,
  jsonb,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { NexusUserSettings } from "@/types/db-types";
import { users } from "./users";

export const nexusUserPreferences = pgTable("nexus_user_preferences", {
  userId: integer("user_id")
    .references(() => users.id)
    .primaryKey(),
  expandedFolders: jsonb("expanded_folders").$type<string[]>().default([]),
  panelWidth: integer("panel_width").default(400),
  sortPreference: varchar("sort_preference", { length: 50 }).default("recent"),
  viewMode: varchar("view_mode", { length: 50 }).default("tree"),
  settings: jsonb("settings").$type<NexusUserSettings>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
