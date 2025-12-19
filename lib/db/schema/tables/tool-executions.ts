/**
 * Tool Executions Table Schema
 * Execution records for assistant architect runs
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { executionStatusEnum } from "../enums";
import { users } from "./users";
import { assistantArchitects } from "./assistant-architects";

export const toolExecutions = pgTable("tool_executions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  inputData: jsonb("input_data").notNull().$type<Record<string, unknown>>(),
  status: executionStatusEnum("status").default("pending").notNull(),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  assistantArchitectId: integer("assistant_architect_id").references(
    () => assistantArchitects.id
  ),
});
