/**
 * Agent Messages Table Schema
 * Per-message telemetry for the Agent Platform (migration 065)
 */

import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const agentMessages = pgTable("agent_messages", {
  // BIGINT GENERATED ALWAYS AS IDENTITY — matches migration 065 exactly.
  // Do NOT use bigserial (different PostgreSQL construct that allows explicit inserts).
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 512 }).notNull(),
  model: varchar("model", { length: 128 }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  guardrailBlocked: boolean("guardrail_blocked").notNull().default(false),
  spaceName: varchar("space_name", { length: 512 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_messages_user_id").on(table.userId, table.createdAt),
  index("idx_agent_messages_created_at").on(table.createdAt),
  // Partial index — only rows where guardrail_blocked = true
  index("idx_agent_messages_guardrail_blocked").on(table.guardrailBlocked, table.createdAt),
]);
