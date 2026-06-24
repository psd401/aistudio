/**
 * Content Index Links Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — maps a content object to its
 * retrieval `repository_item`, reusing the existing vector pipeline rather than
 * building a parallel index. The unique constraint on `object_id` keeps it
 * one-repository-item-per-object.
 *
 * See docs/features/atrium-design-spec.md §7.8 and §16 (retrieval).
 *
 * ## Columns of note
 * - `repository_item_id` — references the existing `repository_items` table
 *   (a `serial`/integer PK), so this column is integer, not uuid.
 * - `indexed_version_id` — the content version last indexed, so a re-index can
 *   detect staleness against the current head.
 *
 * Phase 0 ships the link table; the retrieval indexer that writes rows here lands
 * in Phase 6 per the build plan (§32).
 */

import {
  integer,
  pgTable,
  serial,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { repositoryItems } from "./repository-items";

export const contentIndexLinks = pgTable(
  "content_index_links",
  {
    id: serial("id").primaryKey(),
    objectId: uuid("object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    repositoryItemId: integer("repository_item_id")
      .references(() => repositoryItems.id, { onDelete: "cascade" })
      .notNull(),
    indexedVersionId: uuid("indexed_version_id"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("uq_index_object").on(t.objectId)]
);

export type ContentIndexLinkRow = typeof contentIndexLinks.$inferSelect;
export type NewContentIndexLinkRow = typeof contentIndexLinks.$inferInsert;
