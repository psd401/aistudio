/**
 * Immutable source versions for repository items (Epic #1261, #1265).
 *
 * `repository_items` is the stable logical identity. Each upload or synchronized
 * source revision creates one row here, allowing exact citations, reproducible
 * processing, rollback, and idempotent reprocessing.
 */

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
import { repositoryItems } from "./repository-items";
import { users } from "./users";

export type RepositorySourceKind =
  | "upload"
  | "url"
  | "text"
  | "google_drive"
  | "atrium"
  | "api"
  | "migration";

export type RepositoryStorageStatus =
  | "quarantined"
  | "available"
  | "blocked"
  | "deleted";

export type RepositoryVersionProcessingStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type RepositoryInspectionStatus =
  | "pending"
  | "clean"
  | "blocked"
  | "error"
  | "not_required";

export const repositoryItemVersions = pgTable(
  "repository_item_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: integer("item_id")
      .references(() => repositoryItems.id, { onDelete: "cascade" })
      .notNull(),
    versionNumber: integer("version_number").notNull(),
    sourceKind: varchar("source_kind", { length: 24 })
      .$type<RepositorySourceKind>()
      .notNull(),
    sourceRevision: varchar("source_revision", { length: 512 }),
    objectKey: text("object_key"),
    declaredContentType: varchar("declared_content_type", { length: 255 }),
    detectedContentType: varchar("detected_content_type", { length: 255 }),
    byteSize: bigint("byte_size", { mode: "number" }),
    sha256: char("sha256", { length: 64 }),
    storageStatus: varchar("storage_status", { length: 20 })
      .$type<RepositoryStorageStatus>()
      .default("quarantined")
      .notNull(),
    inspectionStatus: varchar("inspection_status", { length: 20 })
      .$type<RepositoryInspectionStatus>()
      .default("pending")
      .notNull(),
    inspectionDetails: jsonb("inspection_details")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    processingStatus: varchar("processing_status", { length: 20 })
      .$type<RepositoryVersionProcessingStatus>()
      .default("pending")
      .notNull(),
    processorVersion: varchar("processor_version", { length: 128 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_repository_item_version_number").on(t.itemId, t.versionNumber),
    index("idx_repository_item_versions_item_created").on(t.itemId, t.createdAt),
    index("idx_repository_item_versions_processing").on(
      t.processingStatus,
      t.createdAt
    ),
  ]
);

export type RepositoryItemVersionRow = typeof repositoryItemVersions.$inferSelect;
export type NewRepositoryItemVersionRow = typeof repositoryItemVersions.$inferInsert;
