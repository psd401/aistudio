/**
 * Agent Message Content Table Schema (migration 078).
 *
 * Stores the full text of every turn — user prompts, assistant replies,
 * tool exchange messages — so the admin Conversations tab can show a
 * complete transcript. Capped at 64KB per row by the writer; the
 * `content_truncated` flag tells the UI when content was clipped.
 *
 * Retention: 90 days (enforced by the agent-telemetry-prune Lambda).
 * The aggregated summary in `agent_messages` is kept indefinitely.
 */

import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { agentMessages } from "./agent-messages";

export const agentMessageContent = pgTable(
  "agent_message_content",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 512 }).notNull(),
    /** Stores the user's email address. Named `user_email` (vs. `user_id` in
     *  the parent `agent_messages` table) to clarify the value is an email,
     *  not a UUID — the legacy `user_id` column also stores email. */
    userEmail: varchar("user_email", { length: 255 }).notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    contentText: text("content_text").notNull(),
    contentTruncated: boolean("content_truncated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agent_message_content_message_id").on(table.messageId),
    index("idx_agent_message_content_session").on(table.sessionId, table.createdAt),
    index("idx_agent_message_content_user").on(table.userEmail, table.createdAt),
    index("idx_agent_message_content_created_at").on(table.createdAt),
  ],
);
