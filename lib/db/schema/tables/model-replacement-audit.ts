/**
 * Model Replacement Audit Table Schema
 * Audit trail for AI model replacements
 */

import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { aiModels } from "./ai-models";
import { users } from "./users";

export const modelReplacementAudit = pgTable("model_replacement_audit", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  originalModelId: integer("original_model_id")
    .references(() => aiModels.id)
    .notNull(),
  originalModelName: text("original_model_name").notNull(),
  replacementModelId: integer("replacement_model_id")
    .references(() => aiModels.id)
    .notNull(),
  replacementModelName: text("replacement_model_name").notNull(),
  replacedBy: integer("replaced_by").references(() => users.id, { onDelete: "set null" }),
  chainPromptsUpdated: integer("chain_prompts_updated").default(0),
  legacyConversationsUpdated: integer("legacy_conversations_updated").default(0),
  modelComparisonsUpdated: integer("model_comparisons_updated").default(0),
  executedAt: timestamp("executed_at").defaultNow(),
  nexusMessagesUpdated: integer("nexus_messages_updated").default(0),
  nexusConversationsUpdated: integer("nexus_conversations_updated").default(0),
  toolExecutionsUpdated: integer("tool_executions_updated").default(0),
});
