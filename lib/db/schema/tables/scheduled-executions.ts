/**
 * Scheduled Executions Table Schema
 * Scheduled assistant architect runs
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ScheduleConfig } from "@/lib/db/types/jsonb";
import { users } from "./users";
import { assistantArchitects } from "./assistant-architects";
import { agentIdentities } from "./agent-identities";

export const scheduledExecutions = pgTable("scheduled_executions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  assistantArchitectId: integer("assistant_architect_id")
    .references(() => assistantArchitects.id)
    .notNull(),
  name: text("name").notNull(),
  scheduleConfig: jsonb("schedule_config").$type<ScheduleConfig>().default({} as ScheduleConfig),
  inputData: jsonb("input_data").$type<Record<string, string>>().default({} as Record<string, string>),
  active: boolean("active").default(true),
  // Atrium Phase 5 (#1055): when set, the run executes under this autonomous
  // agent identity (content it authors is system-owned + agent-stamped, bounded
  // by the identity's scopes) instead of the owning user. Null = user identity.
  agentIdentityId: uuid("agent_identity_id").references(
    () => agentIdentities.id,
    { onDelete: "set null" }
  ),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
});
