/**
 * Agent Skill Audit Table Schema
 * Append-only audit log for skill lifecycle events (migration 070)
 *
 * Tracks: draft created, auto-promoted, submitted for sharing,
 * approved, rejected, scan results, etc.
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
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";
import { psdAgentSkills } from "./agent-skills";

export const psdAgentSkillAudit = pgTable("psd_agent_skill_audit", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  skillId: uuid("skill_id").references(() => psdAgentSkills.id, { onDelete: "set null" }),
  action: varchar("action", { length: 64 }).notNull(),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  details: jsonb("details").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_agent_skill_audit_skill").on(table.skillId, table.createdAt),
  index("idx_agent_skill_audit_action").on(table.action, table.createdAt),
]);
