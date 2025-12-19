/**
 * Migration Log Table Schema
 * Database migration tracking
 */

import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const migrationLog = pgTable("migration_log", {
  id: serial("id").primaryKey(),
  stepNumber: integer("step_number"),
  description: text("description"),
  sqlExecuted: text("sql_executed"),
  status: varchar("status", { length: 20 }),
  errorMessage: text("error_message"),
  executedAt: timestamp("executed_at").defaultNow(),
});
