/**
 * Agent Credential Reads Table Schema
 * Telemetry for credential access events (migration 070)
 *
 * Records which credential was read, by whom, in which session.
 * Never stores credential values — names only.
 *
 * Part of Epic #910 — Agent Skills Platform
 */

import {
  bigint,
  index,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const psdAgentCredentialReads = pgTable("psd_agent_credential_reads", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  credentialName: varchar("credential_name", { length: 255 }).notNull(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  sessionId: varchar("session_id", { length: 512 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_cred_reads_name").on(table.credentialName, table.createdAt),
  index("idx_agent_cred_reads_user").on(table.userId, table.createdAt),
]);
