/**
 * API Keys Table Schema
 * Stores hashed API keys for external API access
 * Part of Epic #674 (External API Platform) - Issue #684
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  keyPrefix: varchar("key_prefix", { length: 8 }).notNull(),
  keyHash: varchar("key_hash", { length: 64 }).notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  rateLimitRpm: integer("rate_limit_rpm").default(60),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
