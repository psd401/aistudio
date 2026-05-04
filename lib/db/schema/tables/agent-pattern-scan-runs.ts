/**
 * Agent Pattern Scan Runs Table Schema
 *
 * Per-invocation audit of the weekly pattern scanner. Lets the admin dashboard
 * distinguish "scanner never ran" from "scanner ran but everything was below
 * the suppression threshold". Migration 076.
 */

import {
  bigint,
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const agentPatternScanRuns = pgTable(
  "agent_pattern_scan_runs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    week: varchar("week", { length: 16 }).notNull(),
    signalsTotal: integer("signals_total").notNull().default(0),
    topicsTotal: integer("topics_total").notNull().default(0),
    detected: integer("detected").notNull().default(0),
    suppressed: integer("suppressed").notNull().default(0),
  },
  (table) => [
    index("idx_agent_pattern_scan_runs_run_at").on(table.runAt),
  ],
);

export type AgentPatternScanRunRow = typeof agentPatternScanRuns.$inferSelect;
