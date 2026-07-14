/**
 * Content Visibility Grants Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — normalized group-access grants for a
 * content object. Keeping grants in their own indexable table is what lets the
 * permission-pushed `list`/retrieval queries filter in SQL rather than loading
 * objects and dropping them in application code.
 *
 * See docs/features/atrium-design-spec.md §7.5 and §12 (permissions).
 *
 * ## Columns of note
 * - `grant_kind` — the dimension the grant keys on (role / building / department /
 *   grade / user / group).
 * - `grant_value` — the value to match.
 *   - `role` grants: the role **NAME** (e.g. `"staff"`) — matched against
 *     `principal.roles` from `getUserRoles()` which returns names, not ids.
 *   - `user` grants: the numeric user id serialised as text (e.g. `"42"`).
 *   - `building` / `department` / `grade` grants: the attribute string
 *     (e.g. `"High School"`, `"Math"`, `"9"`).
 *   - `group` grants (Epic #1202 Phase 2, #1205): the synced Google group
 *     **EMAIL**, lowercased (e.g. `"hs-staff@psd401.net"`) — matched against
 *     `principal.groups` (the viewer's memberships, from `group_members` joined on
 *     the user's lowercased email). Stored lowercase (emails are case-insensitive)
 *     so the exact-match read predicates hit the `idx_cvg_lookup` index.
 *
 *   ⚠️  DO NOT store a numeric id for `role` grants — the in-memory `canView`
 *   and the SQL `buildVisibilitySql` both match by name, so an id-valued role
 *   grant will never authorize anyone.
 */

import {
  index,
  pgTable,
  serial,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { contentObjects } from "./content-objects";
import { grantKindEnum } from "../enums";

export const contentVisibilityGrants = pgTable(
  "content_visibility_grants",
  {
    id: serial("id").primaryKey(),
    objectId: uuid("object_id")
      .references(() => contentObjects.id, { onDelete: "cascade" })
      .notNull(),
    grantKind: grantKindEnum("grant_kind").notNull(),
    grantValue: varchar("grant_value", { length: 255 }).notNull(),
  },
  (t) => [
    index("idx_cvg_object").on(t.objectId),
    index("idx_cvg_lookup").on(t.grantKind, t.grantValue),
    // Mirrors the DB-level uq_cvg constraint (migration 085 §5): no duplicate
    // (object, kind, value) grant. The service applies grants via
    // delete-then-insert so the normal path never duplicates; this guards
    // future paths / direct SQL.
    unique("uq_cvg").on(t.objectId, t.grantKind, t.grantValue),
  ]
);

export type ContentVisibilityGrantRow =
  typeof contentVisibilityGrants.$inferSelect;
export type NewContentVisibilityGrantRow =
  typeof contentVisibilityGrants.$inferInsert;
