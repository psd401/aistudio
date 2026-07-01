/**
 * Content Audit Logs Table Schema
 *
 * Issue #1055 (Epic #1059, Atrium Phase 5 — Agent access). Append-only trail of
 * every MCP/REST content mutation (§27): who (human / agent), what action, on
 * which object, and the outcome. A district-grade governance record.
 *
 * NOT folded into `nexus_mcp_audit_logs` (its `server_id`/`user_id` are both
 * NOT NULL and do not fit a REST or autonomous-agent content write). `object_id`
 * is nullable and has NO FK so the trail survives object deletion; `actor_user_id`
 * / `agent_id` ON DELETE SET NULL for the same reason.
 *
 * See migration 090 and docs/features/atrium-design-spec.md §27.
 */

import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { agentIdentities } from "./agent-identities";
import { actorKindEnum, publishDestinationEnum } from "../enums";

export const contentAuditLogs = pgTable("content_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** The content object the action targeted; null for a create that never persisted. */
  objectId: uuid("object_id"),
  /** create | update | create_version | set_visibility | publish | unpublish */
  action: varchar("action", { length: 40 }).notNull(),
  /** mcp | rest (the surface the mutation arrived on) */
  surface: varchar("surface", { length: 16 }).notNull(),
  actorKind: actorKindEnum("actor_kind").notNull(),
  /** The human author, when there is one (null for autonomous agents). */
  actorUserId: integer("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  /** The autonomous agent identity, when the actor is an agent. */
  agentId: uuid("agent_id").references(() => agentIdentities.id, {
    onDelete: "set null",
  }),
  agentLabel: text("agent_label"),
  /** Set for publish/unpublish actions. */
  destination: publishDestinationEnum("destination"),
  /** ok | error | approval_required */
  outcome: varchar("outcome", { length: 24 }).notNull(),
  error: text("error"),
  requestId: varchar("request_id", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ContentAuditLogRow = typeof contentAuditLogs.$inferSelect;
export type NewContentAuditLogRow = typeof contentAuditLogs.$inferInsert;
