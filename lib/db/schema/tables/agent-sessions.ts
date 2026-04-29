/**
 * Agent Sessions Table Schema
 * Session-level aggregates for the Agent Platform (migration 065)
 *
 * NOTE: The updated_at column is maintained by the Router Lambda's
 * ON CONFLICT DO UPDATE SET session_end = NOW() clause, not a trigger.
 * A PL/pgSQL trigger was removed because the RDS Data API migration
 * runner cannot execute CREATE FUNCTION statements.
 */

import {
  bigint,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const agentSessions = pgTable("agent_sessions", {
  // BIGINT GENERATED ALWAYS AS IDENTITY — matches migration 065 exactly.
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 512 }).notNull(),
  sessionStart: timestamp("session_start", { withTimezone: true }).notNull().defaultNow(),
  sessionEnd: timestamp("session_end", { withTimezone: true }),
  totalMessages: integer("total_messages").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("agent_sessions_session_id_unique").on(table.sessionId),
  index("idx_agent_sessions_user_id").on(table.userId, table.sessionStart),
]);
