/**
 * Agent Messages Table Schema
 * Per-message telemetry for the Agent Platform (migration 065)
 */

import {
  bigserial,
  boolean,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const agentMessages = pgTable("agent_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 512 }).notNull(),
  model: varchar("model", { length: 128 }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  guardrailBlocked: boolean("guardrail_blocked").notNull().default(false),
  spaceName: varchar("space_name", { length: 512 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
