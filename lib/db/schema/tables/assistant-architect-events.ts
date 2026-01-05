/**
 * Assistant Architect Events Table Schema
 * Execution tracking events for assistant architects
 */

import { integer, jsonb, pgTable, serial, timestamp } from "drizzle-orm/pg-core";
import { assistantEventTypeEnum } from "../enums";

export const assistantArchitectEvents = pgTable("assistant_architect_events", {
  id: serial("id").primaryKey(),
  executionId: integer("execution_id").notNull(),
  eventType: assistantEventTypeEnum("event_type").notNull(),
  eventData: jsonb("event_data").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
