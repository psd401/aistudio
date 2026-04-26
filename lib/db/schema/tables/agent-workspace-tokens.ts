/**
 * Agent Workspace Tokens Table Schema
 * Google Workspace OAuth token manifest for the Agent Platform (migration 071)
 *
 * Tracks per-user workspace connection status. One row per user — their
 * agent account's OAuth state. Actual refresh tokens are in Secrets Manager.
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 *
 * NOTE: status is VARCHAR with CHECK constraint at the DB layer — not
 * PostgreSQL enum — because the db-init Lambda's SQL splitter cannot
 * reliably handle DROP TYPE during migration recovery. Runtime validation
 * in the application enforces the same value set.
 */

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const WORKSPACE_TOKEN_STATUSES = ["pending", "active", "stale", "revoked"] as const;
export type WorkspaceTokenStatus = (typeof WORKSPACE_TOKEN_STATUSES)[number];

// 'agent_account' = OAuth on the agent's own Workspace identity (broad scopes,
// used for Calendar via sharing, Drive ownership, Chat presence).
// 'user_account'  = OAuth on the human user's identity (narrow Phase 1
// scopes for reading their Gmail, Tasks, Drive). Migration 073.
export const WORKSPACE_TOKEN_KINDS = ["agent_account", "user_account"] as const;
export type WorkspaceTokenKind = (typeof WORKSPACE_TOKEN_KINDS)[number];

export const psdAgentWorkspaceTokens = pgTable("psd_agent_workspace_tokens", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  ownerUserId: integer("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ownerEmail: varchar("owner_email", { length: 255 }).notNull(),
  agentEmail: varchar("agent_email", { length: 255 }).notNull(),
  tokenKind: varchar("token_kind", { length: 16 }).$type<WorkspaceTokenKind>().notNull(),
  status: varchar("status", { length: 16 }).$type<WorkspaceTokenStatus>().notNull().default("pending"),
  grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
  secretsManagerArn: text("secrets_manager_arn"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // updated_at is NOT auto-maintained — application code MUST set updatedAt
  // on every update (the db-init splitter cannot execute CREATE TRIGGER).
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_agent_workspace_tokens_owner_kind").on(table.ownerUserId, table.tokenKind),
  index("idx_agent_workspace_tokens_status").on(table.status),
]);
