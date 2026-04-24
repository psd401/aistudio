/**
 * Agent Skills Table Schema
 * Skill registry for the Agent Skills Platform (migration 070)
 *
 * Tracks skills across scopes: shared (district-wide), user (per-user approved),
 * draft (pending scan/review), rejected.
 *
 * Part of Epic #910 — Agent Skills Platform
 *
 * NOTE: scope and scanStatus are VARCHAR with CHECK constraints at the DB
 * layer — not PostgreSQL enums — because the db-init Lambda's SQL splitter
 * cannot reliably handle DROP TYPE during migration recovery. Runtime
 * validation in the application enforces the same value set.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { users } from "./users";

export const AGENT_SKILL_SCOPES = ["shared", "user", "draft", "rejected"] as const;
export type AgentSkillScope = (typeof AGENT_SKILL_SCOPES)[number];

export const AGENT_SKILL_SCAN_STATUSES = ["clean", "flagged", "pending"] as const;
export type AgentSkillScanStatus = (typeof AGENT_SKILL_SCAN_STATUSES)[number];

export interface SkillScanFindings {
  secrets?: string[];
  pii?: string[];
  npmAudit?: { severity: string; title: string }[];
  skillMdLint?: string[];
  summary?: string;
}

export const psdAgentSkills = pgTable("psd_agent_skills", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  scope: varchar("scope", { length: 16 }).$type<AgentSkillScope>().notNull().default("draft"),
  ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  s3Key: text("s3_key").notNull(),
  version: integer("version").notNull().default(1),
  summary: text("summary").notNull(),
  scanStatus: varchar("scan_status", { length: 16 }).$type<AgentSkillScanStatus>().notNull().default("pending"),
  scanFindings: jsonb("scan_findings").$type<SkillScanFindings>(),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // updated_at is NOT auto-maintained — application code MUST set updatedAt
  // on every update (the db-init splitter cannot execute CREATE TRIGGER).
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_skills_scope").on(table.scope),
  index("idx_agent_skills_owner").on(table.ownerUserId),
  index("idx_agent_skills_scan_status").on(table.scanStatus),
  index("idx_agent_skills_scope_clean").on(table.scope, table.name),
  uniqueIndex("idx_agent_skills_shared_name")
    .on(table.name)
    .where(sql`scope = 'shared'`),
  uniqueIndex("idx_agent_skills_user_name_owner")
    .on(table.name, table.ownerUserId)
    .where(sql`scope = 'user'`),
  uniqueIndex("idx_agent_skills_draft_name_owner")
    .on(table.name, table.ownerUserId)
    .where(sql`scope = 'draft'`),
]);
