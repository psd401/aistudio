/**
 * Resource Access Grants Table Schema
 *
 * Epic #1202 Phase 3 (#1206) — direct per-role / per-group access on individual
 * AI Studio resources: models, Assistant Architect assistants, and agent skills.
 * This is the resource-scoped authorization axis, distinct from role-gated UI
 * Capabilities and API-key Scopes (docs/architecture/capabilities-and-scopes.md).
 * SQL table + backfill: migration 111-resource-access-grants.sql.
 *
 * ## Semantics (mirrors the pre-existing ai_models.allowed_roles contract)
 * - ZERO grant rows for a resource = UNRESTRICTED (everyone may access).
 * - ANY matching grant row = allowed. Administrators ALWAYS pass.
 * - Evaluated by `userCanAccessResource` / `filterAccessibleResourceIds`
 *   (lib/db/drizzle/resource-access.ts).
 *
 * ## Columns of note
 * - `resource_type` — 'model' | 'assistant' | 'skill' (VARCHAR + CHECK, not an
 *   enum: matches the psd_agent_skills precedent — the db-init splitter cannot
 *   run DROP TYPE during recovery).
 * - `resource_id` — the resource's PK **as text**. Models/assistants use serial
 *   integer ids (stored as decimal text, e.g. `"42"`); skills use a uuid (stored
 *   as the uuid string). A single shared column must be text because the three
 *   id types are not uniform — the design note's `integer` cannot key skills.
 * - `grant_kind` — 'role' | 'group'.
 * - `grant_value`:
 *   - `role` grants: the role NAME (e.g. `"staff"`), matched case-insensitively
 *     against roles.name via user_roles. Do NOT store a role id.
 *   - `group` grants: the synced Google group EMAIL, lowercased
 *     (e.g. `"hs-staff@psd401.net"`), matched against the viewer's transitive
 *     memberships of ACTIVE groups (group_members joined on lower(email)).
 */

import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/** The resources a grant can key on. Mirrors the DB CHECK on resource_type. */
export const RESOURCE_GRANT_TYPES = ["model", "assistant", "skill"] as const;
export type ResourceGrantType = (typeof RESOURCE_GRANT_TYPES)[number];

/** The access dimensions a grant can key on. Mirrors the DB CHECK on grant_kind. */
export const RESOURCE_GRANT_KINDS = ["role", "group"] as const;
export type ResourceGrantKind = (typeof RESOURCE_GRANT_KINDS)[number];

export const resourceAccessGrants = pgTable(
  "resource_access_grants",
  {
    id: serial("id").primaryKey(),
    resourceType: varchar("resource_type", { length: 16 })
      .$type<ResourceGrantType>()
      .notNull(),
    resourceId: text("resource_id").notNull(),
    grantKind: varchar("grant_kind", { length: 16 })
      .$type<ResourceGrantKind>()
      .notNull(),
    grantValue: text("grant_value").notNull(),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Mirrors the DB-level uq_resource_access_grant: no duplicate grant.
    unique("uq_resource_access_grant").on(
      t.resourceType,
      t.resourceId,
      t.grantKind,
      t.grantValue
    ),
    index("idx_resource_access_grants_resource").on(t.resourceType, t.resourceId),
  ]
);

export type ResourceAccessGrantRow = typeof resourceAccessGrants.$inferSelect;
export type NewResourceAccessGrantRow = typeof resourceAccessGrants.$inferInsert;
