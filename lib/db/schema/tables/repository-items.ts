/**
 * Repository Items Table Schema
 * Individual items within knowledge repositories
 */

import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { knowledgeRepositories } from "./knowledge-repositories";

export const repositoryItems = pgTable("repository_items", {
  id: serial("id").primaryKey(),
  stableId: uuid("stable_id").defaultRandom().notNull(),
  repositoryId: integer("repository_id")
    .references(() => knowledgeRepositories.id, { onDelete: "cascade" })
    .notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  sourceExternalId: text("source_external_id"),
  /** Deferred SQL FK to repository_item_versions.id (migration 116). */
  currentVersionId: uuid("current_version_id"),
  lifecycleStatus: varchar("lifecycle_status", { length: 20 })
    .$type<"active" | "unavailable" | "expired" | "deleting" | "deleted">()
    .default("active")
    .notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  processingStatus: text("processing_status").default("pending"),
  processingError: text("processing_error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
