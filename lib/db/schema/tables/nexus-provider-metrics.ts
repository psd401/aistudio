/**
 * Nexus Provider Metrics Table Schema
 * Token usage and performance metrics per provider request
 */

import {
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusConversations } from "./nexus-conversations";

export const nexusProviderMetrics = pgTable("nexus_provider_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id")
    .references(() => nexusConversations.id)
    .notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  modelId: varchar("model_id", { length: 100 }).notNull(),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  cachedTokens: integer("cached_tokens").default(0),
  reasoningTokens: integer("reasoning_tokens").default(0),
  responseTimeMs: integer("response_time_ms"),
  streamDurationMs: integer("stream_duration_ms"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  requestId: varchar("request_id", { length: 255 }),
  errorMessage: text("error_message"),
  status: varchar("status", { length: 50 }).default("success"),
  createdAt: timestamp("created_at").defaultNow(),
});
