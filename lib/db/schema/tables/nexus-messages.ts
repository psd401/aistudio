/**
 * Nexus Messages Table Schema
 * Individual messages within conversations
 */

import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { nexusConversations } from "./nexus-conversations";
import { aiModels } from "./ai-models";

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface MessagePart {
  type: "text" | "image" | "tool-call";
  text?: string;
  image?: string;
  imageUrl?: string;
  // Tool-call specific fields (flat structure for assistant-ui ToolCallMessagePart compatibility)
  // Note: result is EMBEDDED in the tool-call part (not separate tool-result)
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  argsText?: string;  // JSON stringified args for display
  result?: unknown;   // Tool execution result (embedded in tool-call)
  isError?: boolean;  // Whether the tool execution resulted in an error
}

export const nexusMessages = pgTable("nexus_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id")
    .references(() => nexusConversations.id)
    .notNull(),
  role: varchar("role", { length: 50 }).notNull(),
  content: text("content"),
  parts: jsonb("parts").$type<MessagePart[]>(),
  modelId: integer("model_id").references(() => aiModels.id),
  reasoningContent: text("reasoning_content"),
  tokenUsage: jsonb("token_usage").$type<TokenUsage>(),
  finishReason: varchar("finish_reason", { length: 50 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
