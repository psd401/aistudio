/**
 * Collection-level access grants for Atrium.
 *
 * Issue #1438. A collection grant controls either entry/view access or whether
 * content may be created in the collection. District/shared collections may
 * inherit grants from their ancestors. Owner-bound private collections never
 * carry or inherit grants.
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

export type CollectionGrantAccess = "view" | "create";

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
      sql`${t.access} IN ('view', 'create')`
    ),
  ]
);

export type ContentCollectionGrantRow =
  typeof contentCollectionGrants.$inferSelect;
export type NewContentCollectionGrantRow =
  typeof contentCollectionGrants.$inferInsert;
