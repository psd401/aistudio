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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ScheduleConfig } from "@/lib/db/types/jsonb";
import { users } from "./users";
import { assistantArchitects } from "./assistant-architects";

export const scheduledExecutions = pgTable("scheduled_executions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  assistantArchitectId: integer("assistant_architect_id")
    .references(() => assistantArchitects.id)
    .notNull(),
  name: text("name").notNull(),
  scheduleConfig: jsonb("schedule_config").$type<ScheduleConfig>().default(sql`'{}'::jsonb`).notNull(),
  inputData: jsonb("input_data").$type<Record<string, string>>().default(sql`'{}'::jsonb`).notNull(),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
});
