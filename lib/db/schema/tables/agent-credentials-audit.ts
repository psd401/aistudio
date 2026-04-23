/**
 * Agent Credentials Audit Table Schema
 * Append-only audit log for credential provisioning events (migration 070)
 *
 * Tracks: credential created, updated, deleted by admin.
 * Never stores credential values — names only.
 *
 * Part of Epic #910 — Agent Skills Platform
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const psdAgentCredentialsAudit = pgTable("psd_agent_credentials_audit", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  credentialName: varchar("credential_name", { length: 255 }).notNull(),
  scope: varchar("scope", { length: 32 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_creds_audit_name").on(table.credentialName, table.createdAt),
]);
