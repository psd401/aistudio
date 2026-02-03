/**
 * Chain Prompts Table Schema
 * Individual prompts within an assistant architect workflow
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { assistantArchitects } from "./assistant-architects";
import { aiModels } from "./ai-models";

export const chainPrompts = pgTable("chain_prompts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  content: text("content").notNull(),
  modelId: integer("model_id")
    .references(() => aiModels.id)
    .notNull(),
  position: integer("position").default(0).notNull(),
  parallelGroup: integer("parallel_group"),
  inputMapping: jsonb("input_mapping").$type<Record<string, string>>(),
  timeoutSeconds: integer("timeout_seconds"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  systemContext: text("system_context"),
  assistantArchitectId: integer("assistant_architect_id").references(
    () => assistantArchitects.id
  ),
  repositoryIds: jsonb("repository_ids").$type<number[]>().default([]),
  enabledTools: jsonb("enabled_tools").$type<string[]>().default([]),
});
