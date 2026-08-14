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
  text,
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
     * collection. Private collections never inherit grants (enforced by both
     * the service and the database check below) and may default only to
     * `private` or, once their owner shares them, `group` — never `internal`
     * or `public`.
     */
    ownerUserId: integer("owner_user_id").references(() => users.id, {
      // Empty private trees are organizational metadata and follow their owner
      // on account deletion. Content retains its independent owner FK.
      onDelete: "cascade",
    }),
    inheritGrants: boolean("inherit_grants").default(true).notNull(),
    /**
     * Section hero copy (migration 175). Plain text, shown under the section
     * name on its landing page — what this section is for, in the author's own
     * words. Null for the many sections that predate the landing page.
     */
    description: text("description"),
    /**
     * The optional "start here" object pinned to the top of this section's
     * landing page (migration 175). `ON DELETE SET NULL` — deleting the pinned
     * object unpins it and never touches the section. The service, not the FK,
     * enforces that the target actually lives in this collection and is visible
     * to the reader.
     *
     * Declared WITHOUT `.references()` on purpose: `content_objects` already
     * imports this module for its `collection_id` FK, so pointing back at
     * `contentObjects` here would make the two table modules circular. The FK
     * itself is created in migration 175 — same approach `parent_id` takes for
     * its self-reference.
     */
    landingObjectId: uuid("landing_object_id"),
    /**
     * Section hero art (migration 178) — the S3 object KEY, not a URL, because
     * presigned URLs expire and CDN hosts move. Resolved for display through
     * the existing `/api/images/[...key]` route.
     *
     * Deliberately raster, unlike the object-level `cover_gradient`, which is
     * an allowlisted CSS gradient preset key with "no raster assets" as an
     * explicit design rule. Sections carry real photography and generated
     * header images; documents carry a tint.
     */
    heroImageKey: varchar("hero_image_key", { length: 512 }),
    /** Alt text for `heroImageKey`. Required whenever a hero image is set. */
    heroImageAlt: varchar("hero_image_alt", { length: 300 }),
    /**
     * Per-collection publish review (migration 178). Default false: the
     * district-wide policy stays allow-then-notify (Hagel, 2026-07-25) and
     * authors publish freely everywhere else. Switching this on for a
     * collection — the staff intranet, SOPs — routes publishes out of it
     * through the existing `content_publish_requests` queue instead.
     */
    requiresApproval: boolean("requires_approval").default(false).notNull(),
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
    index("idx_collection_landing_object").on(t.landingObjectId),
    index("idx_collection_requires_approval")
      .on(t.id)
      .where(sql`${t.requiresApproval} = true`),
    check(
      "ck_collection_private_owner_policy",
      sql`${t.ownerUserId} IS NULL OR (${t.defaultVisibilityLevel} IN ('private', 'group') AND ${t.inheritGrants} = false)`
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
