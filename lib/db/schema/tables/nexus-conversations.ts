/**
 * Nexus Conversations Table Schema
 * Main conversation storage for the Nexus chat system
 */

import {
  boolean,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { NexusConversationMetadata } from "@/lib/db/types/jsonb";
import { users } from "./users";
import { nexusFolders } from "./nexus-folders";
import { nexusProjects } from "./nexus-projects";
import { psdAgentSkills } from "./agent-skills";

export const nexusConversations = pgTable(
  "nexus_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: integer("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    externalId: varchar("external_id", { length: 255 }),
    cacheKey: varchar("cache_key", { length: 255 }),
    title: varchar("title", { length: 500 }),
    modelUsed: varchar("model_used", { length: 100 }),
    folderId: uuid("folder_id").references(() => nexusFolders.id),
    projectId: uuid("project_id").references(() => nexusProjects.id, {
      onDelete: "set null",
    }),
    skillId: uuid("skill_id").references(() => psdAgentSkills.id, {
      onDelete: "set null",
    }),
    messageCount: integer("message_count").default(0),
    totalTokens: integer("total_tokens").default(0),
    lastMessageAt: timestamp("last_message_at").defaultNow(),
    isArchived: boolean("is_archived").default(false),
    isPinned: boolean("is_pinned").default(false),
    /**
     * "Keep" flag (#1330). When true the retention sweep never deletes the
     * conversation, regardless of age or archive state. NOT NULL in the
     * database (migration 137) so the sweep predicate has only two states.
     */
    isSaved: boolean("is_saved").notNull().default(false),
    metadata: jsonb("metadata").$type<NexusConversationMetadata>().default({}),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_nexus_conversations_id_user").on(table.id, table.userId),
  ]
);
