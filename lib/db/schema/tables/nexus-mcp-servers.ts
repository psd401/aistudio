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
  /** Dynamic OAuth client registration (client_id, encrypted_client_secret, etc). Set by MCP auth flow. */
  mcpOauthRegistration: jsonb("mcp_oauth_registration"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
