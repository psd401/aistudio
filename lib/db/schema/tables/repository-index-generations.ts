/** Atomic repository retrieval index publication and rollback boundary. */

import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { knowledgeRepositories } from "./knowledge-repositories";

export type RepositoryIndexGenerationStatus =
  | "building"
  | "active"
  | "superseded"
  | "failed";

export const repositoryIndexGenerations = pgTable(
  "repository_index_generations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<RepositoryIndexGenerationStatus>()
      .default("building")
      .notNull(),
    embeddingModel: varchar("embedding_model", { length: 255 }),
    embeddingDimensions: integer("embedding_dimensions"),
    visualEmbeddingModel: varchar("visual_embedding_model", { length: 255 }),
    visualEmbeddingDimensions: integer("visual_embedding_dimensions"),
    segmentationVersion: varchar("segmentation_version", { length: 128 })
      .default("legacy-v1")
      .notNull(),
    processorVersion: varchar("processor_version", { length: 128 }).notNull(),
    sourceVersionCount: integer("source_version_count").default(0).notNull(),
    segmentCount: integer("segment_count").default(0).notNull(),
    errorMessage: text("error_message"),
    embeddingRecoveryQueuedAt: timestamp("embedding_recovery_queued_at", {
      withTimezone: true,
    }),
    embeddingRecoveryAttempts: integer("embedding_recovery_attempts")
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_repository_index_generations_history").on(
      t.repositoryId,
      t.createdAt
    ),
    index("idx_repository_index_generations_embedding_recovery")
      .on(
        t.embeddingRecoveryQueuedAt,
        t.embeddingRecoveryAttempts,
        t.createdAt,
        t.id
      )
      .where(sql`${t.status} IN ('building', 'active', 'failed')`),
  ]
);

export type RepositoryIndexGenerationRow =
  typeof repositoryIndexGenerations.$inferSelect;
export type NewRepositoryIndexGenerationRow =
  typeof repositoryIndexGenerations.$inferInsert;
