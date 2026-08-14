/**
 * Collection-level access grants for Atrium.
 *
 * Issue #1438. A collection grant controls entry/view access, whether content
 * may be created in the collection, or (migration 178) who may approve a
 * publish out of a collection that requires review. District/shared
 * collections may inherit grants from their ancestors.
 *
 * Owner-bound private collections carry their own grants but never INHERIT
 * (`inherit_grants` is pinned false for them by
 * `ck_collection_private_owner_policy`). Migration 178 widened that policy so
 * an owner may share their personal tree at `group` level; the grants that
 * make it shared live in this table, and every one of them is an explicit act
 * by the owner rather than something absorbed from a district ancestor.
 */

import {
  check,
  index,
  integer,
  pgTable,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { grantKindEnum } from "../enums";
import { contentCollections } from "./content-collections";

/**
 * `approve` (migration 178) names the approver roster for a collection whose
 * `requires_approval` flag is set. It is additive to the implicit approvers the
 * service always honours (the collection owner and district admins), so a
 * gated collection is never left with nobody able to clear its queue.
 */
export type CollectionGrantAccess = "view" | "create" | "approve";

export const contentCollectionGrants = pgTable(
  "content_collection_grants",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    collectionId: uuid("collection_id")
      .references(() => contentCollections.id, { onDelete: "cascade" })
      .notNull(),
    access: varchar("access", { length: 16 })
      .$type<CollectionGrantAccess>()
      .notNull(),
    grantKind: grantKindEnum("grant_kind").notNull(),
    grantValue: varchar("grant_value", { length: 255 }).notNull(),
  },
  (t) => [
    index("idx_ccg_collection").on(t.collectionId),
    index("idx_ccg_lookup").on(t.access, t.grantKind, t.grantValue),
    unique("uq_content_collection_grant").on(
      t.collectionId,
      t.access,
      t.grantKind,
      t.grantValue
    ),
    check(
      "ck_content_collection_grant_access",
      sql`${t.access} IN ('view', 'create', 'approve')`
    ),
  ]
);

export type ContentCollectionGrantRow =
  typeof contentCollectionGrants.$inferSelect;
export type NewContentCollectionGrantRow =
  typeof contentCollectionGrants.$inferInsert;
