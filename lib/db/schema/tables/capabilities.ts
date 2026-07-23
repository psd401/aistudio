/**
 * Capabilities Table Schema
 *
 * Role-gated registry of UI features (Nexus access, Assistant Architect access,
 * admin pages, etc.). This is the renamed successor to the old `tools` table —
 * the name `capability` better reflects that these are role-gated feature flags,
 * not invocable tools.
 *
 * Issue #923 (Epic #922) — Unify Agent Platform.
 *
 * Mirrors the legacy `tools` schema plus a `source` column:
 *   - `code`   — registered/managed by the code manifest (lib/capabilities/manifest.ts).
 *                name/description are read-only in the admin UI; only role assignment is editable.
 *   - `manual` — created via the admin UI (legacy or experimental gates). Fully editable.
 *
 * The legacy `tools`/`role_tools` tables were dropped in workstream #6 (Issue
 * #928, migration 084) after all access checks were migrated to
 * `hasCapabilityAccess()`.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Source of a capability record.
 * - `code`: managed by the code manifest (auto-registered on boot/deploy).
 * - `manual`: created/edited through the admin UI.
 */
export type CapabilitySource = "code" | "manual";

export const capabilities = pgTable(
  "capabilities",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    identifier: varchar("identifier", { length: 100 }).notNull().unique(),
    isActive: boolean("is_active").default(true).notNull(),
    source: varchar("source", { length: 20 })
      .$type<CapabilitySource>()
      .default("manual")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    promptChainToolId: integer("prompt_chain_tool_id"),
  },
  (t) => [
    // Mirrors CONSTRAINT capabilities_source_check in migration 079 so the Drizzle
    // schema is the faithful source of truth (drift detection / regeneration).
    check("capabilities_source_check", sql`${t.source} IN ('code', 'manual')`),
    index("idx_capabilities_identifier").on(t.identifier),
    index("idx_capabilities_is_active").on(t.isActive),
    index("idx_capabilities_source").on(t.source),
  ]
);

export type Capability = typeof capabilities.$inferSelect;
export type NewCapability = typeof capabilities.$inferInsert;
