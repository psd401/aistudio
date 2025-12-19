/**
 * Nexus MCP Servers Table Schema
 * Model Context Protocol server registry
 */

import {
  integer,
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
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
