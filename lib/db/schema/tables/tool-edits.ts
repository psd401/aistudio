/**
 * Tool Edits Table Schema
 * Audit log for assistant architect modifications
 */

import { integer, jsonb, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";
import { assistantArchitects } from "./assistant-architects";

export const toolEdits = pgTable("tool_edits", {
  id: serial("id").primaryKey(),
  changes: jsonb("changes").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  assistantArchitectId: integer("assistant_architect_id").references(
    () => assistantArchitects.id
  ),
});
