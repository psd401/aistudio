/**
 * Content Objects Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — the spine of the Atrium content
 * workspace. A content object is the addressable unit of content: a `document`
 * (markdown rendered rich) or an `artifact` (interactive HTML/JS). It carries
 * identity, ownership, placement (collection), visibility, provenance origin,
 * its current version, and lifecycle status.
 *
 * See docs/features/atrium-design-spec.md §4 (domain model) and §7.2.
 *
 * ## Columns of note
 * - `owner_user_id` — the human who owns the object. For autonomous-agent content
 *   this is a designated system user (§26.5); `created_by_actor='agent'` and
 *   `created_by_agent_id` identify the producing agent.
 * - `current_version_id` — points at the working head in `content_versions`. The
 *   FK is added in migration 085 *after* `content_versions` exists (deferred FK),
 *   so it is intentionally not declared with `.references()` here.
 * - `created_by_agent_id` — references `agent_identities` (autonomous agents). It
 *   is not declared as a Drizzle FK to avoid an import cycle with the agent table
 *   and because the column is nullable for human-created content; the SQL FK is
 *   defined in the migration.
 * - `source_ref` — typed JSONB; insert via `sql\`${safeJsonbStringify(v)}::jsonb\``.
 *
 * NOTE: `updated_at` is backed by a PostgreSQL trigger
 * (`update_content_objects_updated_at`, migration 085 §11) that references the
 * pre-existing `update_updated_at_column()` function from migration 017. It is a
 * single-statement `CREATE TRIGGER` (no PL/pgSQL `DO $$` block), which the
 * migration runner's statement splitter handles. Application code also sets
 * `updated_at` via Drizzle `.set({ updatedAt: new Date() })`; the trigger is the
 * DB-level backstop for any write that bypasses the app (bulk sweeps, future
 * migrations).
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { contentCollections } from "./content-collections";
import {
  actorKindEnum,
  contentKindEnum,
  contentStatusEnum,
  visibilityLevelEnum,
} from "../enums";

/**
 * Provenance of the source material an object was derived from. Stored as typed
 * JSONB on `content_objects.source_ref`.
 */
export type SourceRef =
  | { type: "upload"; uploadId: string; filename: string }
  | { type: "object"; objectId: string }
  | { type: "chat"; conversationId: string }
  // OKF import provenance (Phase 8, §36.3): the object was created from an
  // imported Open Knowledge Format bundle. `generator` records the producer id.
  | { type: "okf"; generator: string }
  | { type: "none" };

export const contentObjects = pgTable(
  "content_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: contentKindEnum("kind").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull().unique(),
    ownerUserId: integer("owner_user_id")
      .references(() => users.id)
      .notNull(),
    createdByActor: actorKindEnum("created_by_actor").notNull(),
    // -> agent_identities.id (autonomous agents) | null. SQL FK in migration 085.
    createdByAgentId: uuid("created_by_agent_id"),
    collectionId: uuid("collection_id").references(() => contentCollections.id),
    visibilityLevel: visibilityLevelEnum("visibility_level")
      .default("private")
      .notNull(),
    // -> content_versions.id. Deferred FK added in migration 085 (after versions exist).
    currentVersionId: uuid("current_version_id"),
    sourceRef: jsonb("source_ref").$type<SourceRef>(),
    tags: text("tags").array(),
    status: contentStatusEnum("status").default("draft").notNull(),
    indexedAt: timestamp("indexed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_content_owner").on(t.ownerUserId),
    index("idx_content_collection").on(t.collectionId),
    index("idx_content_status_kind").on(t.status, t.kind),
    index("idx_content_visibility").on(t.visibilityLevel),
    // GIN index backing the `tags && ...` array-overlap filter in listVisible
    // (migration 085 line 109: `CREATE INDEX idx_content_tags ... USING gin(tags)`).
    index("idx_content_tags").using("gin", t.tags),
  ]
);

export type ContentObjectRow = typeof contentObjects.$inferSelect;
export type NewContentObjectRow = typeof contentObjects.$inferInsert;
