/**
 * Prompt Results Table Schema
 * Results from chain prompt executions
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
import { toolExecutions } from "./tool-executions";
import { chainPrompts } from "./chain-prompts";

export const promptResults = pgTable("prompt_results", {
  id: serial("id").primaryKey(),
  inputData: jsonb("input_data").$type<Record<string, unknown>>().default({}),
  outputData: text("output_data"),
  status: executionStatusEnum("status").default("pending").notNull(),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  executionTimeMs: integer("execution_time_ms"),
  userFeedback: text("user_feedback"),
  executionId: integer("execution_id").references(() => toolExecutions.id),
  promptId: integer("prompt_id").references(() => chainPrompts.id),
});
