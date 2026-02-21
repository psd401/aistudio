/**
 * Nexus MCP Servers Table Schema
 * Model Context Protocol server registry
 */

import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Shape of the oauth_credentials JSONB column (admin-configured pre-registered OAuth credentials). */
export interface OAuthCredentialsConfig {
  clientId: string
  /** AES-256-GCM encrypted — use token-encryption module to decrypt */
  encryptedClientSecret: string
  authorizationEndpointUrl?: string
  tokenEndpointUrl?: string
  scopes?: string
}

/** Shape of the mcp_oauth_registration JSONB column (dynamic client registration data). */
export interface McpOauthRegistration {
  client_id: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  /** AES-256-GCM encrypted client secret — use token-encryption module to decrypt */
  encrypted_client_secret?: string
  /** The redirect_uri used when this client was registered. If missing or mismatched, the registration is stale and must be re-done. */
  registered_redirect_uri?: string
}

export const nexusMcpServers = pgTable("nexus_mcp_servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  url: text("url").notNull(),
  transport: varchar("transport", { length: 50 }).notNull(),
  authType: varchar("auth_type", { length: 50 }).notNull(),
  credentialsKey: varchar("credentials_key", { length: 255 }),
  allowedUsers: integer("allowed_users")
    .array()
    .default(sql`'{}'::integer[]`),
  maxConnections: integer("max_connections").default(10),
  /** Admin-configured pre-registered OAuth credentials. clientSecret is AES-256-GCM encrypted. */
  oauthCredentials: jsonb("oauth_credentials").$type<OAuthCredentialsConfig>(),
  /** Dynamic OAuth client registration (client_id, encrypted_client_secret, etc). Set by MCP auth flow. */
  mcpOauthRegistration: jsonb("mcp_oauth_registration").$type<McpOauthRegistration>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
