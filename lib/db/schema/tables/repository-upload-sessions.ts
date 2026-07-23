/** Resumable upload coordination records for canonical repository ingestion. */

import {
  bigint,
  char,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";
import { repositoryItemVersions } from "./repository-item-versions";
import { users } from "./users";

export type RepositoryUploadStatus =
  | "initiated"
  | "uploading"
  | "uploaded"
  | "completed"
  | "aborted"
  | "expired";

export const repositoryUploadSessions = pgTable(
  "repository_upload_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: integer("repository_id")
      .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
      .notNull(),
    itemVersionId: uuid("item_version_id").references(
      () => repositoryItemVersions.id,
      { onDelete: "set null" }
    ),
    createdBy: integer("created_by")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    objectKey: text("object_key").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    uploadMethod: varchar("upload_method", { length: 16 })
      .$type<"single" | "multipart">()
      .notNull(),
    partSize: bigint("part_size", { mode: "number" }),
    partCount: integer("part_count"),
    itemName: varchar("item_name", { length: 500 }).notNull(),
    originalFileName: varchar("original_file_name", { length: 500 }).notNull(),
    declaredContentType: varchar("declared_content_type", { length: 255 }).notNull(),
    expectedByteSize: bigint("expected_byte_size", { mode: "number" }).notNull(),
    expectedSha256: char("expected_sha256", { length: 64 }),
    status: varchar("status", { length: 20 })
      .$type<RepositoryUploadStatus>()
      .default("initiated")
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_repository_upload_object_key").on(t.objectKey),
    index("idx_repository_upload_expiry").on(t.status, t.expiresAt),
    index("idx_repository_upload_owner").on(t.createdBy, t.createdAt),
  ]
);

export type RepositoryUploadSessionRow = typeof repositoryUploadSessions.$inferSelect;
export type NewRepositoryUploadSessionRow = typeof repositoryUploadSessions.$inferInsert;
