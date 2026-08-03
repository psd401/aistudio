/**
 * Content User Favorites Table Schema (migration 175)
 *
 * A per-user star on a content object — the backing store for the "Favorites"
 * band on the Atrium library home.
 *
 * WHY A JOIN TABLE: `content_objects` rows are shared across everyone who can
 * see them, so a per-user flag cannot live there. Nothing else in the schema
 * recorded per-user interaction with content either (`content_audit_logs` is
 * mutation-only — its action union has no read/view member), so there was no
 * existing signal to derive a personal view from.
 *
 * IDENTITY: the composite primary key `(user_id, object_id)` IS the row's
 * identity — there is no surrogate id. That makes "is this favorited" an
 * index-only lookup and lets the toggle use `ON CONFLICT DO NOTHING` without a
 * pre-read.
 *
 * VISIBILITY IS NOT IMPLIED. A favorite row grants nothing: reads that join
 * through it must still pass the object through the normal visibility gate, or
 * a user who favorited something before it was restricted would keep seeing it.
 */

import { index, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { contentObjects } from "./content-objects";

export const contentUserFavorites = pgTable(
  "content_user_favorites",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => contentObjects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.objectId] }),
    // Reverse direction: cascade-by-object and any per-object favorite count.
    index("idx_content_user_favorites_object").on(t.objectId),
    // Serves the favorites list newest-first without a sort step.
    index("idx_content_user_favorites_user_created").on(t.userId, t.createdAt),
  ]
);

export type ContentUserFavoriteRow = typeof contentUserFavorites.$inferSelect;
export type NewContentUserFavoriteRow = typeof contentUserFavorites.$inferInsert;
