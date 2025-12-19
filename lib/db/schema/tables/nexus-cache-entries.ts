/**
 * Nexus Cache Entries Table Schema
 * Provider-specific prompt caching metadata
 */

import {
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusConversations } from "./nexus-conversations";

export const nexusCacheEntries = pgTable("nexus_cache_entries", {
  cacheKey: varchar("cache_key", { length: 255 }).primaryKey(),
  provider: varchar("provider", { length: 50 }).notNull(),
  conversationId: uuid("conversation_id").references(
    () => nexusConversations.id
  ),
  ttl: integer("ttl").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  hitCount: integer("hit_count").default(0),
  byteSize: integer("byte_size"),
  createdAt: timestamp("created_at").defaultNow(),
});
