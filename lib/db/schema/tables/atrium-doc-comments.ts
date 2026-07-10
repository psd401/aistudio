/**
 * Atrium Document Comments Table Schema
 *
 * Epic #1059 (Atrium comments & track-changes, §18.1). The durable store for
 * comment threads anchored in a collaborative document by the ProseMirror comment
 * mark (lib/content/collab/comment-mark.ts). The mark carries only a `threadId`;
 * the thread's bodies (root + replies) and resolved state live here so they
 * persist outside the Y.Doc CRDT and are queryable / permission-gated by the
 * content services.
 *
 * One row per comment:
 * - `parentId` NULL → the thread ROOT (one per `threadId`).
 * - `parentId` = root id → a reply (ON DELETE CASCADE with its root).
 *
 * `threadId` matches the comment mark's `data-thread-id` (a client-minted uuid),
 * NOT this table's `id`; the anchor and the store are joined by `threadId`.
 * `resolved` is thread-level state mirrored onto every row of the thread.
 *
 * Authorship mirrors content_versions / content_audit_logs: `authorUserId` for a
 * human, `authorAgentId` for an autonomous agent, `authorLabel` as a display
 * label. Both author FKs ON DELETE SET NULL (a thread survives a deleted
 * principal); `objectId` ON DELETE CASCADE (a deleted document takes its comments).
 *
 * See migration 098 and docs/features/atrium-design-spec.md §18.1.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { users } from "./users";
import { agentIdentities } from "./agent-identities";

export const atriumDocComments = pgTable(
  "atrium_doc_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    objectId: uuid("object_id")
      .notNull()
      .references(() => contentObjects.id, { onDelete: "cascade" }),
    /** The comment mark's threadId (client-minted uuid), NOT this row id. */
    threadId: uuid("thread_id").notNull(),
    /** NULL = the thread root; otherwise the root row this reply hangs under. */
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => atriumDocComments.id,
      { onDelete: "cascade" }
    ),
    body: text("body").notNull(),
    /** Human author (or a delegated agent's human); NULL for an autonomous agent. */
    authorUserId: integer("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The autonomous agent identity, when the author is one. */
    authorAgentId: uuid("author_agent_id").references(
      () => agentIdentities.id,
      { onDelete: "set null" }
    ),
    /** Denormalized display label (an agent label, or a captured human name). */
    authorLabel: text("author_label"),
    /** Thread-level resolved state, mirrored onto every row of the thread. */
    resolved: boolean("resolved").default(false).notNull(),
    resolvedByUserId: integer("resolved_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Thread lookup + per-object grouping for the reader panel.
    index("idx_adc_object_thread").on(t.objectId, t.threadId),
    // Unresolved-root count (query filters to parent_id IS NULL).
    index("idx_adc_object_resolved").on(t.objectId, t.resolved),
  ]
);

export type AtriumDocCommentRow = typeof atriumDocComments.$inferSelect;
export type NewAtriumDocCommentRow = typeof atriumDocComments.$inferInsert;
