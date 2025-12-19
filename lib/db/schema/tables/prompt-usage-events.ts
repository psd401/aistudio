/**
 * Prompt Usage Events Table Schema
 * Analytics tracking for prompt library usage
 */

import {
  integer,
  pgTable,
  serial,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { promptLibrary } from "./prompt-library";
import { users } from "./users";
import { nexusConversations } from "./nexus-conversations";

export const promptUsageEvents = pgTable("prompt_usage_events", {
  id: serial("id").primaryKey(),
  promptId: uuid("prompt_id")
    .references(() => promptLibrary.id)
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  eventType: varchar("event_type", { length: 20 }).notNull(),
  conversationId: uuid("conversation_id").references(
    () => nexusConversations.id
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
