/**
 * Server-owned bindings between a Nexus attachment draft, its eventual
 * conversation, and the private repository that stores canonical sources.
 */

import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";
import { nexusConversations } from "./nexus-conversations";
import { users } from "./users";

export const nexusRepositoryBindings = pgTable(
  "nexus_repository_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: integer("owner_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    draftKey: uuid("draft_key").notNull(),
    conversationId: uuid("conversation_id"),
    repositoryId: integer("repository_id").notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_nexus_repository_binding_owner_draft").on(
      table.ownerId,
      table.draftKey
    ),
    uniqueIndex("uq_nexus_repository_binding_repository").on(
      table.repositoryId
    ),
    index("idx_nexus_repository_binding_conversation")
      .on(table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
    index("idx_nexus_repository_binding_owner_created").on(
      table.ownerId,
      table.createdAt
    ),
    foreignKey({
      columns: [table.conversationId, table.ownerId],
      foreignColumns: [nexusConversations.id, nexusConversations.userId],
      name: "fk_nexus_repository_binding_conversation_owner",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.repositoryId, table.ownerId],
      foreignColumns: [knowledgeRepositories.id, knowledgeRepositories.ownerId],
      name: "fk_nexus_repository_binding_repository_owner",
    }).onDelete("cascade"),
  ]
);

export type NexusRepositoryBindingRow =
  typeof nexusRepositoryBindings.$inferSelect;
export type NewNexusRepositoryBindingRow =
  typeof nexusRepositoryBindings.$inferInsert;
