/**
 * AI Streaming Jobs Table Schema
 * Async AI streaming job management
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { jobStatusEnum } from "../enums";
import { users } from "./users";
import { aiModels } from "./ai-models";

export const aiStreamingJobs = pgTable("ai_streaming_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: text("conversation_id"),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  modelId: integer("model_id")
    .references(() => aiModels.id)
    .notNull(),
  status: jobStatusEnum("status").default("pending").notNull(),
  requestData: jsonb("request_data").notNull().$type<Record<string, unknown>>(),
  responseData: jsonb("response_data").$type<Record<string, unknown>>(),
  partialContent: text("partial_content"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  messagePersisted: boolean("message_persisted").default(false),
});
