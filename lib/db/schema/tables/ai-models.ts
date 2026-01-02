/**
 * AI Models Table Schema
 * AI/LLM model registry with capabilities and pricing
 */

import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { NexusCapabilities, ProviderMetadata } from "@/lib/db/types/jsonb";

export const aiModels = pgTable("ai_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull().unique(),
  description: text("description"),
  capabilities: text("capabilities"),
  maxTokens: integer("max_tokens"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
  nexusEnabled: boolean("nexus_enabled").default(true).notNull(),
  architectEnabled: boolean("architect_enabled").default(true).notNull(),
  allowedRoles: jsonb("allowed_roles").$type<string[]>(),
  inputCostPer1kTokens: numeric("input_cost_per_1k_tokens", {
    precision: 10,
    scale: 6,
  }),
  outputCostPer1kTokens: numeric("output_cost_per_1k_tokens", {
    precision: 10,
    scale: 6,
  }),
  cachedInputCostPer1kTokens: numeric("cached_input_cost_per_1k_tokens", {
    precision: 10,
    scale: 6,
  }),
  pricingUpdatedAt: timestamp("pricing_updated_at"),
  averageLatencyMs: integer("average_latency_ms"),
  maxConcurrency: integer("max_concurrency").default(10),
  supportsBatching: boolean("supports_batching").default(false),
  nexusCapabilities: jsonb("nexus_capabilities").$type<NexusCapabilities>(),
  providerMetadata: jsonb("provider_metadata")
    .$type<ProviderMetadata>()
    .default({}),
});
