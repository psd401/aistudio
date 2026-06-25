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
 * - `oauth_client_id` — the OIDC client-credentials client used to authenticate.
 */

import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { agentIdentityKindEnum } from "../enums";

export const agentIdentities = pgTable("agent_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  kind: agentIdentityKindEnum("kind").notNull(),
  roleId: integer("role_id").references(() => roles.id),
  scopes: text("scopes").array().notNull(),
  oauthClientId: varchar("oauth_client_id", { length: 255 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AgentIdentityRow = typeof agentIdentities.$inferSelect;
export type NewAgentIdentityRow = typeof agentIdentities.$inferInsert;
