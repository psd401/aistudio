/**
 * Agent Health Snapshots — daily per-user workspace health (migration 069)
 * Written by infra/lambdas/agent-health-daily. Read by the admin Health tab.
 */

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const agentHealthSnapshots = pgTable("agent_health_snapshots", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  snapshotDate: date("snapshot_date").notNull(),
  userEmail: varchar("user_email", { length: 255 }).notNull(),
  workspacePrefix: varchar("workspace_prefix", { length: 255 }).notNull(),
  workspaceBytes: bigint("workspace_bytes", { mode: "number" }).notNull().default(0),
  objectCount: integer("object_count").notNull().default(0),
  skillCount: integer("skill_count").notNull().default(0),
  memoryFileCount: integer("memory_file_count").notNull().default(0),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  daysInactive: integer("days_inactive"),
  abandoned: boolean("abandoned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_agent_health_unique").on(table.snapshotDate, table.userEmail),
  index("idx_agent_health_abandoned").on(table.snapshotDate, table.abandoned),
]);
