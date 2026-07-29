/**
 * Content Collections Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — a section of the Atrium intranet. A
 * collection is simultaneously the navigation grouping, the default visibility
 * for objects placed in it, and a retrieval scope.
 *
 * See docs/features/atrium-design-spec.md §7.4 and §4 (domain model).
 *
 * ## Columns of note
 * - `parent_id` — a self-referential tree. Declared via the `foreignKey` helper
 *   in the table-constraints callback (Drizzle supports self-references there even
 *   though it cannot at column-definition time), so the relationship is visible to
 *   the schema generator. The matching SQL constraint name `fk_collection_parent`
 *   is created in migration 085.
 * - `nav_item_id` — links a collection to its `navigation_items` row so the
 *   collection surfaces in the sidebar.
 * - `default_visibility_level` — applied to objects created in the collection when
 *   no explicit visibility is supplied.
 */

import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { navigationItems } from "./navigation-items";
import { users } from "./users";
import { visibilityLevelEnum } from "../enums";

export const contentCollections = pgTable(
  "content_collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull().unique(),
    // Self-referential tree (see foreignKey constraint below).
    parentId: uuid("parent_id"),
    defaultVisibilityLevel: visibilityLevelEnum("default_visibility_level")
      .default("internal")
      .notNull(),
    /**
     * NULL = district/shared collection. A user id = owner-bound private
     * collection. Private collections are forced to private/no-inheritance by
     * both the service and the database check below.
     */
    ownerUserId: integer("owner_user_id").references(() => users.id, {
      // Empty private trees are organizational metadata and follow their owner
      // on account deletion. Content retains its independent owner FK.
      onDelete: "cascade",
    }),
    inheritGrants: boolean("inherit_grants").default(true).notNull(),
    archivedAt: timestamp("archived_at"),
    navItemId: integer("nav_item_id").references(() => navigationItems.id),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_collection_parent").on(t.parentId),
    index("idx_collection_owner").on(t.ownerUserId),
    index("idx_collection_archived").on(t.archivedAt),
    check(
      "ck_collection_private_owner_policy",
      sql`${t.ownerUserId} IS NULL OR (${t.defaultVisibilityLevel} = 'private' AND ${t.inheritGrants} = false)`
    ),
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: "fk_collection_parent",
    }),
  ]
);

export type ContentCollectionRow = typeof contentCollections.$inferSelect;
export type NewContentCollectionRow = typeof contentCollections.$inferInsert;
