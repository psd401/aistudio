/**
 * Agent Identities Table Schema
 *
 * Issue #1058 (Epic #1059, Atrium Phase 0) — autonomous (non-delegated) agents:
 * service accounts and system skills that produce content under their own role
 * and scopes, authenticated via OAuth client-credentials on the existing OIDC
 * provider. Delegated agents act on behalf of a user and need no row here.
 *
 * See docs/features/atrium-design-spec.md §7.7 and §26 (agent identity & authz).
 *
 * ## Columns of note
 * - `role_id` — the role whose grants determine what content the identity can see.
 * - `scopes` — content scopes the identity holds (e.g. `content:create`,
 *   `content:publish_internal`). Autonomous identities never hold
 *   `content:publish_public` — the public-publish gate (§26.4) enforces this.
 * - `name` — the logical key every seeding path (migrations 085/095,
 *   scripts/seed-atrium-agents.ts) matches on. UNIQUE since migration 140
 *   (#1303): before that constraint existed, two seeding paths keyed on
 *   different columns (085 on name, 095 on a fixed id) could each insert a row
 *   for the same name on a fresh environment. Upsert on this column — never
 *   read-then-insert.
 * - `oauth_client_id` — the OIDC client-credentials client used to authenticate.
 */

import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { agentIdentityKindEnum } from "../enums";

export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    kind: agentIdentityKindEnum("kind").notNull(),
    roleId: integer("role_id").references(() => roles.id),
    scopes: text("scopes").array().notNull(),
    oauthClientId: varchar("oauth_client_id", { length: 255 }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Migration 140 (#1303). One row per logical identity, enforced by the
    // database so no seeding path can add a second row for a name. This index
    // is also the ON CONFLICT arbiter every upsert-by-name must target.
    uniqueIndex("uq_agent_identities_name").on(table.name),
  ]
);

export type AgentIdentityRow = typeof agentIdentities.$inferSelect;
export type NewAgentIdentityRow = typeof agentIdentities.$inferInsert;
