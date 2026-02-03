/**
 * Prompt Library Table Schema
 * Saved and shared prompts
 */

import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { nexusConversations } from "./nexus-conversations";
import { nexusMessages } from "./nexus-messages";

export const promptLibrary = pgTable("prompt_library", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  description: text("description"),
  visibility: varchar("visibility", { length: 20 }).default("private").notNull(),
  moderationStatus: varchar("moderation_status", { length: 20 })
    .default("pending")
    .notNull(),
  moderatedBy: integer("moderated_by").references(() => users.id, { onDelete: "set null" }),
  moderatedAt: timestamp("moderated_at"),
  moderationNotes: text("moderation_notes"),
  sourceMessageId: uuid("source_message_id").references(() => nexusMessages.id),
  sourceConversationId: uuid("source_conversation_id").references(
    () => nexusConversations.id
  ),
  viewCount: integer("view_count").default(0).notNull(),
  useCount: integer("use_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});
