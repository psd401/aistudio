/**
 * Nexus MCP Capabilities Table Schema
 * Capabilities exposed by MCP servers
 */

import {
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { NexusMcpSchema } from "@/lib/db/types/jsonb";
import { nexusMcpServers } from "./nexus-mcp-servers";

export const nexusMcpCapabilities = pgTable("nexus_mcp_capabilities", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id")
    .references(() => nexusMcpServers.id)
    .notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  inputSchema: jsonb("input_schema").$type<NexusMcpSchema>().default({} as NexusMcpSchema),
  outputSchema: jsonb("output_schema").$type<NexusMcpSchema>(),
  sandboxLevel: varchar("sandbox_level", { length: 50 }).default("standard"),
  rateLimit: integer("rate_limit").default(10),
});
