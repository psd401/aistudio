/**
 * Content Publications Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — a record that a specific version of
 * an object is live at a destination. The unique `(object_id, destination)`
 * constraint makes publish idempotent (upsert on republish).
 *
 * See docs/features/atrium-design-spec.md §7.6 and §15 (publishing).
 *
 * ## Columns of note
 * - `published_version_id` — what is actually live; may lag the object's
 *   `current_version_id` until an explicit republish.
 * - `external_ref` — destination-specific identifier (public URL, Schoology/Google
 *   id) populated by the publish adapter.
 *
 * Phase 0 builds the data model and service spine. The publish service and
 * adapters (which write rows here) arrive in Phase 5/7 per the build plan (§32).
 */

import {
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { contentVersions } from "./content-versions";
import { users } from "./users";
import { publicationStatusEnum, publishDestinationEnum } from "../enums";

export const contentPublications = pgTable(
  "content_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    objectId: uuid("object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    destination: publishDestinationEnum("destination").notNull(),
    publishedVersionId: uuid("published_version_id")
      .references(() => contentVersions.id)
      .notNull(),
    externalRef: text("external_ref"),
    status: publicationStatusEnum("status").default("live").notNull(),
    publishedBy: integer("published_by").references(() => users.id),
    publishedAt: timestamp("published_at").defaultNow().notNull(),
    // Audit timestamp for status transitions (live -> unpublished -> failed);
    // published_at records first-publish only. Backed by a DB trigger (migration
    // 085 §11); app code sets it via Drizzle as the fast path.
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("uq_pub_object_destination").on(t.objectId, t.destination)]
);

export type ContentPublicationRow = typeof contentPublications.$inferSelect;
export type NewContentPublicationRow = typeof contentPublications.$inferInsert;
