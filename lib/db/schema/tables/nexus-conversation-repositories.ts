import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";
import { nexusConversations } from "./nexus-conversations";
import { users } from "./users";

export const NEXUS_REPOSITORY_BINDING_SOURCES = [
  "direct",
  "project",
  "skill",
  "assistant",
] as const;

export type NexusRepositoryBindingSource =
  (typeof NEXUS_REPOSITORY_BINDING_SOURCES)[number];

export const nexusConversationRepositories = pgTable(
  "nexus_conversation_repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .references(() => nexusConversations.id, { onDelete: "cascade" })
      .notNull(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    source: varchar("source", { length: 16 })
      .$type<NexusRepositoryBindingSource>()
      .notNull(),
    sourceId: varchar("source_id", { length: 255 }).notNull().default(""),
    createdBy: integer("created_by")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_nexus_conversation_repository_source").on(
      table.conversationId,
      table.repositoryId,
      table.source,
      table.sourceId
    ),
    index("idx_nexus_conversation_repositories_conversation").on(
      table.conversationId,
      table.repositoryId
    ),
    index("idx_nexus_conversation_repositories_repository").on(
      table.repositoryId,
      table.conversationId
    ),
    index("idx_nexus_conversation_repositories_creator").on(
      table.createdBy,
      table.createdAt
    ),
  ]
);
