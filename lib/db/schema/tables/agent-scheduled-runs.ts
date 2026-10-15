/**
 * Agent Scheduled Runs Table Schema
 *
 * Records each EventBridge Scheduler fire and its terminal status so schedule
 * owners can see whether their automation last succeeded, failed, or was
 * skipped before invocation. Migrations 066, 067, 165 (`fire_key`) and 188
 * (`owner_notified_at`).
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
    /**
     * When the owner was sent the Chat message saying this schedule is
     * failing (#1890). Set on the one run of a failure streak that carried
     * the message, so the streak's suppression is a recorded fact rather
     * than something inferred from how long the streak happens to be.
     */
    ownerNotifiedAt: timestamp("owner_notified_at", { withTimezone: true }),
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
    // Both streak readers take a schedule's newest 500 streak-deciding runs.
    // Partial on exactly those statuses so the LIMIT bounds rows READ, not
    // rows kept after walking past every skipped/promoted one (migration 188).
    index("idx_agent_scheduled_runs_streak")
      .on(table.userId, table.scheduleId, desc(table.createdAt), desc(table.id))
      .where(sql`status IN ('success', 'error', 'deferred')`),
  ],
);

export type AgentScheduledRunRow = typeof agentScheduledRuns.$inferSelect;
