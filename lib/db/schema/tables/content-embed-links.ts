/**
 * Content Embed Links Table Schema
 *
 * Issue #1059 (Epic #1059, Atrium Phase 2 — Meridian slice D). Backlink store for
 * the artifact viewer's "EMBEDDED IN" rail card: one row per (document, artifact)
 * embed edge.
 *
 * A document embeds an artifact via the leaf directive
 * `::atrium-artifact{id="<uuid>"}` in its canonical markdown
 * (lib/content/embed-directive.ts). The shared snapshot write primitive
 * (`versionService.snapshotInTx`) parses those ids from the document body on every
 * version write and REPLACES this document's rows (delete-then-insert in the same
 * transaction), so the table always mirrors the latest snapshot.
 *
 * Both FKs ON DELETE CASCADE so deleting the embedding document OR the embedded
 * artifact removes the stale edge automatically. See migration 102.
 */

import { index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";

export const contentEmbedLinks = pgTable(
  "content_embed_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The document containing the embed directive. */
    documentObjectId: uuid("document_object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    /** The artifact the document embeds. */
    artifactObjectId: uuid("artifact_object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uq_content_embed_links").on(t.documentObjectId, t.artifactObjectId),
    index("idx_content_embed_links_artifact").on(t.artifactObjectId),
    index("idx_content_embed_links_document").on(t.documentObjectId),
  ]
);

export type ContentEmbedLinkRow = typeof contentEmbedLinks.$inferSelect;
export type NewContentEmbedLinkRow = typeof contentEmbedLinks.$inferInsert;
