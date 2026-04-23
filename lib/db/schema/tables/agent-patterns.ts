/**
 * Agent Patterns — weekly cross-building topic convergence (migration 069).
 * Written by infra/lambdas/agent-pattern-scanner. Read by the admin Patterns tab.
 *
 * Privacy: no user identity, no message content. Stores aggregated topic
 * counts + list of building names. Suppressed below 3 signals / 2 buildings.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const agentPatterns = pgTable("agent_patterns", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  week: varchar("week", { length: 10 }).notNull(),
  topic: varchar("topic", { length: 64 }).notNull(),
  signalCount: integer("signal_count").notNull(),
  buildingCount: integer("building_count").notNull(),
  rollingAvg: real("rolling_avg").notNull(),
  spikeRatio: real("spike_ratio").notNull(),
  isEmerging: boolean("is_emerging").notNull().default(false),
  buildings: text("buildings").notNull(),
}, (table) => [
  index("idx_agent_patterns_week").on(table.week, table.topic),
  uniqueIndex("idx_agent_patterns_unique").on(table.week, table.topic),
]);
