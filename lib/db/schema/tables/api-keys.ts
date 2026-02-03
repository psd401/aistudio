/**
 * API Keys Table Schema
 * Stores hashed API keys for external API access
 * Part of Epic #674 (External API Platform) - Issue #684
 *
 * Security Practices:
 * - Key generation: Use crypto.randomBytes(32) for high-entropy random keys
 * - Hashing: Argon2id (OWASP recommended) stored in key_hash column (~97 chars)
 * - Prefix: First 8 hex chars of key stored for display + lookup during validation
 * - CRITICAL: Never store or log plaintext API keys after initial generation
 * - Key verification: Look up by key_prefix, verify with argon2.verify()
 * - Migration 052 widened key_hash from VARCHAR(64) to VARCHAR(128) for Argon2
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
import { sql } from "drizzle-orm";
import { users } from "./users";

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  keyPrefix: varchar("key_prefix", { length: 8 }).notNull(),
  keyHash: varchar("key_hash", { length: 128 }).notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  rateLimitRpm: integer("rate_limit_rpm").default(60),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
