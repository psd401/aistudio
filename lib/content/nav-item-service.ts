/**
 * Atrium navigation-item service (auto-nav on publish)
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4). When an object is published to the
 * intranet, a `navigation_items` row is created/updated so the published object
 * surfaces in the intranet IA; when it is unpublished, that row is deactivated.
 * Called by the intranet publish adapter (`publish-adapters/intranet.ts`), which
 * runs AFTER the publish transaction commits.
 *
 * ## How a content nav item is identified
 * Content nav items are keyed by `navigation_items.content_object_id` (the FK
 * added in migration 085 §9), NOT by a dedicated `type` enum value. The
 * `navigation_type` enum is intentionally NOT extended with a `content` value:
 * the enum is owned by `postgres` while migrations run as `master`, so
 * `ALTER TYPE ... ADD VALUE` fails on Aurora with SQLSTATE 42501 ("must be owner
 * of type"), and the fail-fast migration runner cannot tolerate it (verified
 * against migration 085's header note + the runner in db-init-handler.ts). The
 * `type` column therefore stays `'link'` (a content nav item IS a link to the
 * reader route); identity is always `content_object_id`.
 *
 * ## Why content nav items must be excluded from the GLOBAL navbar
 * The global navbar (`/api/navigation`) filters nav items by ROLE/CAPABILITY, not
 * by the content object's `canView` visibility. Surfacing a content nav item
 * there would leak a visibility-restricted object's TITLE to any authenticated
 * user (a building-scoped doc title shown to the whole district). So the global
 * navbar query excludes rows with `content_object_id IS NOT NULL`
 * (`lib/db/drizzle/navigation.ts`), and content is surfaced ONLY through the
 * visibility-filtered reader sidebar / `CollectionTree`.
 *
 * ## Idempotency
 * `ensureNavItem` upserts on `content_object_id`: a republish updates the label
 * and re-activates the row in place rather than creating duplicates.
 * `hideNavItem` flips `is_active=false` (a soft hide) so a later republish can
 * re-activate the same row, preserving its id and any manual ordering.
 *
 * See docs/features/atrium-design-spec.md §15.2 / §21.
 */

import { and, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentCollections, navigationItems } from "@/lib/db/schema";

/**
 * The `navigation_type` value used for content nav items. A content nav item is a
 * link to the reader route, so `'link'` is the honest type. We do NOT use a
 * `'content'` enum value — see the module header: `ALTER TYPE ... ADD VALUE`
 * cannot run on Aurora (the enum is postgres-owned, migrations run as master →
 * 42501). Identity is `content_object_id`, never the type. The global navbar
 * excludes content rows by `content_object_id IS NOT NULL`, not by type.
 */
const CONTENT_NAV_TYPE = "link" as const;

/**
 * Default icon for an auto-created content nav item. `navigation_items.icon` is
 * NOT NULL; a content row is never rendered by the global navbar (it skips
 * non-`link|section|page` types), so this value is only a stored default. Use a
 * real `iconMap` key (`components/navigation/icon-map.ts`) so any future surface
 * that DOES render it can resolve the icon.
 */
const CONTENT_NAV_ICON = "IconFileAnalytics";

/** The minimal object shape the nav-item writers need. */
export interface NavObject {
  id: string;
  title: string;
  slug: string;
  collectionId: string | null;
}

/**
 * Resolve the `navigation_items.id` a content nav item should be parented under:
 * the `nav_item_id` of the object's collection, when the collection has one. A
 * collection without a nav item (or an object with no collection) yields a
 * top-level content nav item (`parent_id = null`).
 */
async function parentNavItemIdFor(
  collectionId: string | null
): Promise<number | null> {
  if (!collectionId) return null;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ navItemId: contentCollections.navItemId })
        .from(contentCollections)
        .where(eq(contentCollections.id, collectionId))
        .limit(1),
    "navItem.parentFor"
  );
  return rows[0]?.navItemId ?? null;
}

export const navItemService = {
  /**
   * Create or update the `content` nav item for a published object. Idempotent on
   * `content_object_id`: a republish updates the label / parent and re-activates
   * the existing row rather than inserting a duplicate. The link points at the
   * intranet reader route (`/c/[slug]`).
   *
   * ATOMIC upsert keyed by `content_object_id` (unique constraint
   * `uq_nav_content_object`, migration 087): a single `INSERT ... ON CONFLICT
   * DO UPDATE` replaces the former check-then-insert, so two OVERLAPPING publishes
   * of the same object can no longer both observe "no row" and both insert — the
   * second conflicts and updates the same row. The DO UPDATE branch is also the
   * republish path (re-activates a previously hidden row, preserving its id and
   * any manual position).
   */
  async ensureNavItem(object: NavObject): Promise<void> {
    const parentId = await parentNavItemIdFor(object.collectionId);
    const link = `/c/${object.slug}`;

    await executeQuery(
      (db) =>
        db
          .insert(navigationItems)
          .values({
            label: object.title,
            icon: CONTENT_NAV_ICON,
            link,
            parentId,
            type: CONTENT_NAV_TYPE,
            isActive: true,
            contentObjectId: object.id,
          })
          .onConflictDoUpdate({
            target: navigationItems.contentObjectId,
            set: {
              label: object.title,
              link,
              parentId,
              type: CONTENT_NAV_TYPE,
              isActive: true,
            },
          }),
      "navItem.upsert"
    );
  },

  /**
   * Deactivate the content nav item for an object (unpublish). A soft hide
   * (`is_active=false`) so a later republish re-activates the same row via
   * `ensureNavItem`, preserving its id and ordering. A no-op when no nav item
   * exists for the object.
   */
  async hideNavItem(objectId: string): Promise<void> {
    await executeQuery(
      (db) =>
        db
          .update(navigationItems)
          .set({ isActive: false })
          .where(
            and(
              eq(navigationItems.contentObjectId, objectId),
              eq(navigationItems.isActive, true)
            )
          ),
      "navItem.hide"
    );
  },
};
