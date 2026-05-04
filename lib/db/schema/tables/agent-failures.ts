/**
 * Agent Failures Table Schema
 *
 * Captures failures from every agent chokepoint (router Lambda, harness adapter,
 * cron Lambda, agent self-report) so the /admin/agents dashboard can surface a
 * single failure feed for triage. Migration 076.
 */

import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export type AgentFailureSource =
  | "router"
  | "harness"
  | "cron"
  | "agent_self_report"
  | "tool";

export type AgentFailureSeverity = "error" | "warn" | "empty_response";

export interface AgentFailureContext {
  requestId?: string;
  messageId?: string | number;
  scheduledRunId?: number;
  toolName?: string;
  latencyMs?: number;
  inputTokenCount?: number;
  outputTokenCount?: number;
  turn?: number;
  invocationArn?: string;
  // Additional free-form fields permitted; the column is JSONB.
  [key: string]: unknown;
}

export const agentFailures = pgTable(
  "agent_failures",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: varchar("source", { length: 32 }).$type<AgentFailureSource>().notNull(),
    severity: varchar("severity", { length: 16 })
      .$type<AgentFailureSeverity>()
      .notNull(),
    userId: varchar("user_id", { length: 255 }),
    sessionId: varchar("session_id", { length: 512 }),
    scheduleName: varchar("schedule_name", { length: 255 }),
    model: varchar("model", { length: 128 }),
    errorClass: varchar("error_class", { length: 128 }),
    errorMessage: text("error_message"),
    stackExcerpt: text("stack_excerpt"),
    context: jsonb("context").$type<AgentFailureContext>(),
    acknowledged: boolean("acknowledged").notNull().default(false),
    acknowledgedBy: varchar("acknowledged_by", { length: 255 }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (table) => [
    index("idx_agent_failures_occurred_at").on(table.occurredAt),
    index("idx_agent_failures_source").on(table.source, table.occurredAt),
    index("idx_agent_failures_user").on(table.userId, table.occurredAt),
    index("idx_agent_failures_unack").on(table.occurredAt),
    index("idx_agent_failures_severity").on(table.severity, table.occurredAt),
  ],
);

export type AgentFailureRow = typeof agentFailures.$inferSelect;
export type NewAgentFailureRow = typeof agentFailures.$inferInsert;
