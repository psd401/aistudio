/**
 * Nexus Conversation Events Table Schema
 * Event audit log for conversation changes
 */

import { jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { NexusConversationEventData } from "@/lib/db/types/jsonb";
import { nexusConversations } from "./nexus-conversations";

export const nexusConversationEvents = pgTable("nexus_conversation_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id")
    .references(() => nexusConversations.id)
    .notNull(),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  eventData: jsonb("event_data")
    .notNull()
    .$type<NexusConversationEventData>(),
  createdAt: timestamp("created_at").defaultNow(),
});
