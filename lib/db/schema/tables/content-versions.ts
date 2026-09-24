/**
 * Content Versions Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — immutable snapshots of a content
 * object's body, each attributed to a human or agent author. The version list is
 * the object's history; `content_objects.current_version_id` points at the head.
 *
 * See docs/features/atrium-design-spec.md §7.3 and §14 (versioning).
 *
 * ## Columns of note
 * - `version_number` — 1-based, allocated per object under the
 *   `uq_version_object_number` constraint which guards concurrent-write races.
 * - `body_location` — where the body lives: an `s3://…` key, the literal `"proof"`
 *   (documents whose live state is in the Proof doc-store), or `"inline"` (small
 *   artifact code stored in `body_inline`).
 * - `author_actor` — the per-version provenance grain for artifacts (and the
 *   author of each document snapshot).
 * - `author_agent_id` — references `agent_identities` (autonomous agents); the SQL
 *   FK is defined in migration 085 (not a Drizzle FK to avoid an import cycle).
 */

import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { users } from "./users";
import { actorKindEnum, bodyFormatEnum } from "../enums";

export const contentVersions = pgTable(
  "content_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    objectId: uuid("object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    versionNumber: integer("version_number").notNull(),
    authorActor: actorKindEnum("author_actor").notNull(),
    authorUserId: integer("author_user_id").references(() => users.id),
    // -> agent_identities.id (autonomous agents). SQL FK in migration 085.
    authorAgentId: uuid("author_agent_id"),
    /**
     * Free-text authoring-surface label (#1791, migration 183), e.g.
     * `"nexus-chat"`. NULL for a version a person wrote directly in the editor.
     *
     * The Nexus workspace chat tools run under the USER's own requester — the
     * right call for authorization, since the model can never exceed what the
     * person may do — so `author_actor` is `human` and `author_agent_id` is NULL
     * for a version the chat model wrote. That made "who wrote this SQL?"
     * unanswerable from the version list. This label carries the surface
     * without weakening the authorization record above it; it mirrors the
     * `authorLabel` that `applyAgentEdit` already stamps on comment threads for
     * a non-UUID agent name.
     */
    authorLabel: varchar("author_label", { length: 64 }),
    bodyFormat: bodyFormatEnum("body_format").notNull(),
    bodyLocation: text("body_location").notNull(),
    bodyInline: text("body_inline"),
    renderLocation: text("render_location"),
    proofDocRef: varchar("proof_doc_ref", { length: 255 }),
    summary: text("summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uq_version_object_number").on(t.objectId, t.versionNumber),
    index("idx_version_object").on(t.objectId),
  ]
);

export type ContentVersionRow = typeof contentVersions.$inferSelect;
export type NewContentVersionRow = typeof contentVersions.$inferInsert;
