/**
 * OAuth Refresh Tokens Table Schema
 * Supports token rotation with grace period.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { oauthClients } from "./oauth-clients"
import { oauthAccessTokens } from "./oauth-access-tokens"
import { users } from "./users"

export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  id: serial("id").primaryKey(),
  tokenHash: varchar("token_hash", { length: 255 }).notNull().unique(),
  clientId: varchar("client_id", { length: 255 })
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessTokenJti: varchar("access_token_jti", { length: 255 })
    .references(() => oauthAccessTokens.jti, { onDelete: "set null" }),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  rotatedToId: integer("rotated_to_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
