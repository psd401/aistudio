import {
  bigserial,
  index,
  integer,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";

export type RepositoryRetrievalProduct =
  "repository_manager" | "nexus" | "assistant_architect";

export const repositoryRetrievalShadowObservations = pgTable(
  "repository_retrieval_shadow_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    product: varchar("product", { length: 32 })
      .$type<RepositoryRetrievalProduct>()
      .notNull(),
    searchMode: varchar("search_mode", { length: 16 })
      .$type<"vector" | "keyword" | "hybrid">()
      .notNull(),
    legacyResultCount: integer("legacy_result_count").notNull(),
    canonicalResultCount: integer("canonical_result_count").notNull(),
    overlappingItemCount: integer("overlapping_item_count").notNull(),
    legacyDurationMs: integer("legacy_duration_ms").notNull(),
    canonicalDurationMs: integer("canonical_duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_repository_retrieval_shadow_created").on(table.createdAt),
    index("idx_repository_retrieval_shadow_repository").on(
      table.repositoryId,
      table.createdAt,
    ),
  ],
);

export type RepositoryRetrievalShadowObservationRow =
  typeof repositoryRetrievalShadowObservations.$inferSelect;
