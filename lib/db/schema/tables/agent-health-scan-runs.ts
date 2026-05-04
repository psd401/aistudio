/**
 * Agent Health Scan Runs Table Schema
 *
 * Per-invocation audit of the daily health Lambda. Lets the admin dashboard
 * surface "last successful run" so an empty `agent_health_snapshots` table is
 * distinguishable from "Lambda never ran". Migration 076.
 */

import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const agentHealthScanRuns = pgTable(
  "agent_health_scan_runs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    snapshotDate: date("snapshot_date").notNull(),
    usersTotal: integer("users_total").notNull().default(0),
    abandoned: integer("abandoned").notNull().default(0),
    error: text("error"),
  },
  (table) => [
    index("idx_agent_health_scan_runs_run_at").on(table.runAt),
  ],
);

export type AgentHealthScanRunRow = typeof agentHealthScanRuns.$inferSelect;
