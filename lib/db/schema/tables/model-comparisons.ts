/**
 * Model Comparisons Table Schema
 * Side-by-side AI model comparison results
 */

import {
  bigserial,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { aiModels } from "./ai-models";

export const modelComparisons = pgTable("model_comparisons", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "set null" }),
  prompt: text("prompt").notNull(),
  model1Id: integer("model1_id").references(() => aiModels.id),
  model2Id: integer("model2_id").references(() => aiModels.id),
  response1: text("response1"),
  response2: text("response2"),
  model1Name: text("model1_name"),
  model2Name: text("model2_name"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  executionTimeMs1: integer("execution_time_ms1"),
  executionTimeMs2: integer("execution_time_ms2"),
  tokensUsed1: integer("tokens_used1"),
  tokensUsed2: integer("tokens_used2"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
