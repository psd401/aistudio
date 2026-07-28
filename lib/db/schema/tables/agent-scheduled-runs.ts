/**
 * Agent Scheduled Runs Table Schema
 *
 * Records each EventBridge Scheduler fire and its terminal status so schedule
 * owners can see whether their automation last succeeded, failed, or was
 * skipped before invocation. Migrations 066, 067, and 164.
 */

import { desc, sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const agentScheduledRuns = pgTable(
  "agent_scheduled_runs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    scheduleType: varchar("schedule_type", { length: 64 }),
    sessionId: varchar("session_id", { length: 512 }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: varchar("status", { length: 32 }).notNull().default("success"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    scheduleId: varchar("schedule_id", { length: 64 }),
    scheduleName: varchar("schedule_name", { length: 256 }),
    fireKey: varchar("fire_key", { length: 192 }),
  },
  (table) => [
    index("idx_agent_scheduled_runs_user").on(
      table.userId,
      desc(table.createdAt),
    ),
    index("idx_agent_scheduled_runs_type").on(
      table.scheduleType,
      desc(table.createdAt),
    ),
    index("idx_agent_scheduled_runs_schedule").on(
      table.scheduleId,
      desc(table.createdAt),
    ),
    uniqueIndex("uq_agent_scheduled_runs_fire")
      .on(table.fireKey)
      .where(sql`fire_key IS NOT NULL`),
  ],
);

export type AgentScheduledRunRow = typeof agentScheduledRuns.$inferSelect;
