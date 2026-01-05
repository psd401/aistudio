/**
 * Execution Results Table Schema
 * Results from scheduled assistant architect executions
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { scheduledExecutions } from "./scheduled-executions";

export const executionResults = pgTable("execution_results", {
  id: serial("id").primaryKey(),
  scheduledExecutionId: integer("scheduled_execution_id")
    .references(() => scheduledExecutions.id)
    .notNull(),
  resultData: jsonb("result_data").$type<Record<string, unknown>>().default({}).notNull(),
  status: text("status").notNull(),
  executedAt: timestamp("executed_at").defaultNow(),
  executionDurationMs: integer("execution_duration_ms"),
  errorMessage: text("error_message"),
});
