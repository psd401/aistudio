/**
 * Agent Tool Invocations Table Schema (migration 078).
 *
 * One row per tool call the agent made during a turn. Carries the args
 * (JSONB), result (JSONB), status, and timing so the admin Conversations
 * tab can render a chronological tool timeline alongside the transcript.
 *
 * tool_args / tool_result are capped at 16KB each by the writer
 * (truncation marker lives inside the JSON object as `{ "_truncated": true }`
 * by convention). Retention: 90 days, pruned by agent-telemetry-prune.
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { agentMessages } from "./agent-messages";

export const agentToolInvocations = pgTable(
  "agent_tool_invocations",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 512 }).notNull(),
    userEmail: varchar("user_email", { length: 255 }).notNull(),
    toolName: varchar("tool_name", { length: 255 }).notNull(),
    toolArgs: jsonb("tool_args").$type<Record<string, unknown> | null>(),
    toolResult: jsonb("tool_result").$type<Record<string, unknown> | null>(),
    status: varchar("status", { length: 16 }).notNull(),
    errorText: text("error_text"),
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_tool_invocations_tool").on(table.toolName, table.startedAt),
    index("idx_agent_tool_invocations_session").on(table.sessionId, table.startedAt),
    index("idx_agent_tool_invocations_user").on(table.userEmail, table.startedAt),
    index("idx_agent_tool_invocations_created_at").on(table.createdAt),
  ],
);
