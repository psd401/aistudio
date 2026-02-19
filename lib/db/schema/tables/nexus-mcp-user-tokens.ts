/**
 * Nexus MCP User Tokens Table Schema
 * Per-user encrypted OAuth token storage for MCP server connections
 *
 * Part of Epic #774 - Nexus MCP Connectors
 * Issue #776
 */

import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusMcpServers } from "./nexus-mcp-servers";
import { users } from "./users";

export const nexusMcpUserTokens = pgTable(
  "nexus_mcp_user_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    serverId: uuid("server_id")
      .references(() => nexusMcpServers.id, { onDelete: "cascade" })
      .notNull(),
    encryptedAccessToken: text("encrypted_access_token"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scope: varchar("scope", { length: 1000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("nexus_mcp_user_tokens_user_server_unique").on(
      table.userId,
      table.serverId
    ),
  ]
);
