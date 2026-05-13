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
  // Which credential slot is being consented.
  //  - 'agent_account' = Google OAuth for agnt_<uniqname> (#912 Phase 1)
  //  - 'user_account'  = Google OAuth for the user themself
  //  - 'cognito_data'  = Cognito refresh-token capture for the agent's
  //                      data-MCP integration. Reuses this table because
  //                      the per-owner rate-limit + nonce-replay protection
  //                      are exactly what we need; the consume step writes
  //                      to a different secret path.
  tokenKind: varchar("token_kind", { length: 16 })
    .$type<"agent_account" | "user_account" | "cognito_data">()
    .notNull()
    .default("agent_account"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [
  index("idx_agent_workspace_nonces_cleanup").on(table.createdAt),
]);
