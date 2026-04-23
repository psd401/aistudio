/**
 * Agent Credential Requests Table Schema
 * Pending credential requests linked to Freshservice tickets (migration 070)
 *
 * When an agent calls credentials.request_new(), a row is inserted here
 * and a Freshservice ticket is filed. Admin fulfills the request by
 * creating the secret in Secrets Manager and resolving this row.
 *
 * Part of Epic #910 — Agent Skills Platform
 */

import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

export const psdAgentCredentialRequests = pgTable("psd_agent_credential_requests", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  credentialName: varchar("credential_name", { length: 255 }).notNull(),
  reason: text("reason").notNull(),
  skillContext: text("skill_context"),
  requestedBy: varchar("requested_by", { length: 255 }).notNull(),
  freshserviceTicketId: varchar("freshservice_ticket_id", { length: 64 }),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_cred_requests_status").on(table.status),
]);
