/**
 * Agent Sessions Table Schema
 * Session-level aggregates for the Agent Platform (migration 065)
 */

import {
  bigserial,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const agentSessions = pgTable("agent_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 512 }).notNull().unique(),
  sessionStart: timestamp("session_start", { withTimezone: true }).notNull().defaultNow(),
  sessionEnd: timestamp("session_end", { withTimezone: true }),
  totalMessages: integer("total_messages").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
