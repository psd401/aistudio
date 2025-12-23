/**
 * Nexus Shares Table Schema
 * Shared conversation links
 */

import {
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusConversations } from "./nexus-conversations";
import { users } from "./users";

export const nexusShares = pgTable("nexus_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id")
    .references(() => nexusConversations.id)
    .notNull(),
  sharedBy: integer("shared_by")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  shareToken: varchar("share_token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at"),
  viewCount: integer("view_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});
