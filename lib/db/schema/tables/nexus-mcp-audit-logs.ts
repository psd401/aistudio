/**
 * Nexus MCP Audit Logs Table Schema
 * Audit trail for MCP tool invocations
 */

import {
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusMcpServers } from "./nexus-mcp-servers";
import { users } from "./users";

export const nexusMcpAuditLogs = pgTable("nexus_mcp_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  serverId: uuid("server_id")
    .references(() => nexusMcpServers.id)
    .notNull(),
  toolName: varchar("tool_name", { length: 255 }).notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  error: text("error"),
  durationMs: integer("duration_ms"),
  ipAddress: inet("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
});
