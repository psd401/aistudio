/**
 * Persistent, user-owned memories used by Nexus chat (Issue #1407).
 *
 * Content is stored only through the memory service's write-time safety
 * pipeline. `deletedAt` is a soft-delete marker so every read must select live
 * rows explicitly.
 */

import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { vector } from "../custom-types"
import { nexusConversations } from "./nexus-conversations"
import { users } from "./users"

export const NEXUS_MEMORY_CATEGORIES = [
  "profile",
  "preference",
  "context",
] as const

export type NexusMemoryCategory =
  (typeof NEXUS_MEMORY_CATEGORIES)[number]

export const NEXUS_MEMORY_SOURCES = [
  "tool",
  "manual",
  "auto",
  "import:chatgpt",
  "import:claude",
  "import:gemini",
] as const

export type NexusMemorySource = (typeof NEXUS_MEMORY_SOURCES)[number]

export const nexusUserMemories = pgTable("nexus_user_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  category: text("category")
    .$type<NexusMemoryCategory>()
    .notNull()
    .default("context"),
  source: text("source").$type<NexusMemorySource>().notNull(),
  sourceConversationId: uuid("source_conversation_id").references(
    () => nexusConversations.id,
    { onDelete: "set null" },
  ),
  embedding: vector("embedding", 512),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})
