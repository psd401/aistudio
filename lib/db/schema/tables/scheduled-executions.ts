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
import type { ScheduleConfig } from "@/types/db-types";
import { users } from "./users";
import { assistantArchitects } from "./assistant-architects";

export const scheduledExecutions = pgTable("scheduled_executions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  assistantArchitectId: integer("assistant_architect_id")
    .references(() => assistantArchitects.id)
    .notNull(),
  name: text("name").notNull(),
  scheduleConfig: jsonb("schedule_config").notNull().$type<ScheduleConfig>(),
  inputData: jsonb("input_data").notNull().$type<Record<string, string>>(),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
});
