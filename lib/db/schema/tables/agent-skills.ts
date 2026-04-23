/**
 * Agent Skills Table Schema
 * Skill registry for the Agent Skills Platform (migration 070)
 *
 * Tracks skills across scopes: shared (district-wide), user (per-user approved),
 * draft (pending scan/review), rejected.
 *
 * Part of Epic #910 — Agent Skills Platform
 */

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { users } from "./users";

export const agentSkillScopeEnum = pgEnum("agent_skill_scope", [
  "shared",
  "user",
  "draft",
  "rejected",
]);

export const agentSkillScanStatusEnum = pgEnum("agent_skill_scan_status", [
  "clean",
  "flagged",
  "pending",
]);

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
  scope: agentSkillScopeEnum("scope").notNull().default("draft"),
  ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  s3Key: text("s3_key").notNull(),
  version: integer("version").notNull().default(1),
  summary: text("summary").notNull(),
  scanStatus: agentSkillScanStatusEnum("scan_status").notNull().default("pending"),
  scanFindings: jsonb("scan_findings").$type<SkillScanFindings>(),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_skills_scope").on(table.scope),
  index("idx_agent_skills_owner").on(table.ownerUserId),
  index("idx_agent_skills_scan_status").on(table.scanStatus),
  // Partial unique indexes per scope — the composite (name, owner_user_id, scope) index
  // doesn't enforce uniqueness for shared skills because owner_user_id is NULL and
  // PostgreSQL unique indexes allow multiple NULLs.
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
