/**
 * Agent Feedback Table Schema
 * User thumbs-up/down on agent messages (migration 065)
 */

import {
  bigint,
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { agentMessages } from "./agent-messages";

export const agentFeedback = pgTable("agent_feedback", {
  // BIGINT GENERATED ALWAYS AS IDENTITY — matches migration 065 exactly.
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  messageId: bigint("message_id", { mode: "number" })
    .notNull()
    .references(() => agentMessages.id, { onDelete: "cascade" }),
  thumbsUp: boolean("thumbs_up").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_agent_feedback_unique").on(table.userId, table.messageId),
  index("idx_agent_feedback_message_id").on(table.messageId),
]);
