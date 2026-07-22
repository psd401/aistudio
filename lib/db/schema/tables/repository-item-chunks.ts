/**
 * Repository Item Chunks Table Schema
 * Chunked content with vector embeddings for semantic search
 */

import {
  char,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tsvector, vector } from "../custom-types";
import { repositoryItems } from "./repository-items";
import { repositoryItemVersions } from "./repository-item-versions";
import { repositoryArtifacts } from "./repository-artifacts";
import { repositoryIndexGenerations } from "./repository-index-generations";

export interface RepositorySourceLocator {
  page?: number;
  pageEnd?: number;
  paragraph?: number;
  paragraphEnd?: number;
  slide?: number;
  sheet?: string;
  cellRange?: string;
  headingPath?: string[];
  timeStartMs?: number;
  timeEndMs?: number;
  regions?: Array<{
    page?: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface RepositorySegmentAccessScope {
  /** Empty or absent arrays inherit repository access. Present empty arrays deny all. */
  userIds?: number[];
  roleIds?: number[];
}

export const repositoryItemChunks = pgTable("repository_item_chunks", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id")
    .references(() => repositoryItems.id, { onDelete: "cascade" })
    .notNull(),
  itemVersionId: uuid("item_version_id").references(
    () => repositoryItemVersions.id,
    { onDelete: "cascade" }
  ),
  artifactId: uuid("artifact_id").references(() => repositoryArtifacts.id, {
    onDelete: "set null",
  }),
  indexGenerationId: uuid("index_generation_id").references(
    () => repositoryIndexGenerations.id,
    { onDelete: "cascade" }
  ),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  modality: varchar("modality", { length: 16 })
    .$type<"text" | "image" | "audio" | "video" | "table">()
    .default("text")
    .notNull(),
  contentHash: char("content_hash", { length: 64 }),
  sourceLocator: jsonb("source_locator")
    .$type<RepositorySourceLocator>()
    .default({})
    .notNull(),
  contextPrefix: text("context_prefix").default("").notNull(),
  segmentLevel: varchar("segment_level", { length: 16 })
    .$type<"document" | "section" | "chunk">()
    .default("chunk")
    .notNull(),
  parentChunkIndex: integer("parent_chunk_index"),
  accessScope: jsonb("access_scope")
    .$type<RepositorySegmentAccessScope>()
    .default({})
    .notNull(),
  searchVector: tsvector("search_vector"),
  embedding: vector("embedding"),
  visualEmbedding: vector("visual_embedding"),
  tokens: integer("tokens"),
  createdAt: timestamp("created_at").defaultNow(),
});
