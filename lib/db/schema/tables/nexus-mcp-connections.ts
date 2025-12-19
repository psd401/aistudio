/**
 * Nexus MCP Connections Table Schema
 * User connections to MCP servers
 */

import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusMcpServers } from "./nexus-mcp-servers";
import { users } from "./users";

export const nexusMcpConnections = pgTable("nexus_mcp_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id")
    .references(() => nexusMcpServers.id)
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  lastHealthCheck: timestamp("last_health_check"),
  latencyMs: integer("latency_ms"),
  errorCount: integer("error_count").default(0),
  successCount: integer("success_count").default(0),
  circuitState: varchar("circuit_state", { length: 50 }).default("closed"),
  lastError: text("last_error"),
  lastConnectedAt: timestamp("last_connected_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
