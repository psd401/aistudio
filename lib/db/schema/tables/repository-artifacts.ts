/** Derived, version-pinned multimodal artifacts for repository ingestion. */

import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { repositoryItemVersions } from "./repository-item-versions";

export type RepositoryArtifactKind =
  | "source"
  | "canonical_text"
  | "markdown"
  | "layout"
  | "table"
  | "image"
  | "thumbnail"
  | "audio"
  | "video"
  | "transcript"
  | "caption";

export interface RepositorySourceRegion {
  page?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const repositoryArtifacts = pgTable(
  "repository_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemVersionId: uuid("item_version_id")
      .references(() => repositoryItemVersions.id, { onDelete: "cascade" })
      .notNull(),
    artifactKey: varchar("artifact_key", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 32 }).$type<RepositoryArtifactKind>().notNull(),
    mediaType: varchar("media_type", { length: 255 }).notNull(),
    objectKey: text("object_key"),
    textInline: text("text_inline"),
    sha256: char("sha256", { length: 64 }),
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    timeStartMs: bigint("time_start_ms", { mode: "number" }),
    timeEndMs: bigint("time_end_ms", { mode: "number" }),
    sourceRegions: jsonb("source_regions")
      .$type<RepositorySourceRegion[]>()
      .default([])
      .notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    processorName: varchar("processor_name", { length: 128 }).notNull(),
    processorVersion: varchar("processor_version", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_repository_artifact_key").on(t.artifactKey),
    index("idx_repository_artifacts_version_kind").on(
      t.itemVersionId,
      t.kind,
      t.createdAt
    ),
  ]
);

export type RepositoryArtifactRow = typeof repositoryArtifacts.$inferSelect;
export type NewRepositoryArtifactRow = typeof repositoryArtifacts.$inferInsert;
