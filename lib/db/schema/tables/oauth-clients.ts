/**
 * OAuth Clients Table Schema
 * Registered OAuth2 applications that can request tokens.
 * Part of Issue #686 - MCP Server + OAuth2/OIDC Provider (Phase 3)
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { users } from "./users"

export const oauthClients = pgTable("oauth_clients", {
  id: serial("id").primaryKey(),
  clientId: varchar("client_id", { length: 255 }).notNull().unique(),
  clientName: varchar("client_name", { length: 255 }).notNull(),
  clientSecretHash: varchar("client_secret_hash", { length: 255 }),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  allowedScopes: jsonb("allowed_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  grantTypes: jsonb("grant_types").$type<string[]>().notNull().default(sql`'["authorization_code"]'::jsonb`),
  responseTypes: jsonb("response_types").$type<string[]>().notNull().default(sql`'["code"]'::jsonb`),
  tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", { length: 50 }).notNull().default("none"),
  requirePkce: boolean("require_pkce").notNull().default(true),
  accessTokenTtl: integer("access_token_ttl").notNull().default(900),
  refreshTokenTtl: integer("refresh_token_ttl").notNull().default(86400),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
