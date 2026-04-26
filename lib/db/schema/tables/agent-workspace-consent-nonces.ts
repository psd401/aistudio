/**
 * Agent Workspace Consent Nonces Table Schema
 * One-time-use nonces for Google Workspace consent links (migration 071)
 *
 * Each nonce is consumed when the OAuth callback completes, preventing replay
 * attacks on consent URLs. Old nonces can be cleaned up via a scheduled job
 * (created_at index supports efficient range deletes).
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

import {
  index,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const psdAgentWorkspaceConsentNonces = pgTable("psd_agent_workspace_consent_nonces", {
  nonce: varchar("nonce", { length: 64 }).primaryKey(),
  ownerEmail: varchar("owner_email", { length: 255 }).notNull(),
  // Stored alongside the nonce so the OAuth callback can recover both
  // identities from just the nonce (the OAuth `state` parameter no longer
  // carries the full consent JWT — the nonce alone is sufficient).
  agentEmail: varchar("agent_email", { length: 255 }).notNull(),
  // Which OAuth identity is being consented (#912 Phase 1, migration 073).
  // 'agent_account' = agnt_<uniqname>; 'user_account' = the user themself.
  tokenKind: varchar("token_kind", { length: 16 })
    .$type<"agent_account" | "user_account">()
    .notNull()
    .default("agent_account"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [
  index("idx_agent_workspace_nonces_cleanup").on(table.createdAt),
]);
