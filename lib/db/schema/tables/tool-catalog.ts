/**
 * Tool Catalog Table Schema
 *
 * Issue #924 (Epic #922, workstream #2) — single source of truth for *invocable
 * units* (tools) exposed by AI Studio across every surface: the MCP server, AI
 * SDK chat/Nexus, the REST API, and internal agent loops.
 *
 * IMPORTANT — this is NOT the legacy `tools` table (`lib/db/schema/tables/tools.ts`),
 * which is the pre-#923 role-gated *feature flag* registry kept alive as a compat
 * shim and dropped in workstream #6. To avoid a physical name collision while that
 * legacy table still exists, the canonical tool catalog lives in `tool_catalog`.
 *
 * ## Hybrid model (decision for this issue)
 *
 * Code-defined tools live in a TypeScript manifest (`lib/tools/catalog/manifest.ts`)
 * and are reconciled into this table on boot by `lib/tools/catalog/sync.ts`
 * (`source = 'code'`), exactly parallel to the capability manifest from #923.
 * Assistant-derived and (future) skill-derived tools are written to this table by
 * their own lifecycle hooks (`source = 'assistant'` / `'skill'`). A unified
 * `ToolCatalog` (`lib/tools/catalog/catalog.ts`) merges manifest + DB at runtime.
 *
 * ## Columns of note
 *
 * - `identifier` — stable `domain.action` string ID (e.g. `decisions.search`,
 *   `assistants.execute`). Immutable once shipped (changing it orphans references).
 * - `version` — `v1`, `v2`, ... Multiple versions of the same logical tool can
 *   coexist; the UNIQUE constraint is on `(identifier, version)`.
 * - `surfaces` — JSON array of surfaces that expose this tool
 *   (`mcp`, `ai_sdk`, `rest`, `internal`).
 * - `required_scopes` — JSON array of API scope strings the caller must hold.
 * - `agent_callable` — when false, internal agent loops may NOT invoke the tool
 *   even if the scope allows it (human-only / destructive guard).
 * - `source` — `code` (manifest-managed) | `assistant` | `skill`.
 * - `handler_ref` — for `source = 'code'`, the manifest handler key; for
 *   `assistant`/`skill`, a pointer (e.g. `assistant:42`) the dispatcher resolves.
 * - `deprecated_at` / `replaced_by` / `removal_date` / `grace_period_days` —
 *   version deprecation lifecycle (Issue #927). `deprecated_at` is the timestamp a
 *   version was marked deprecated; `replaced_by` points at the successor
 *   `identifier@version`; `grace_period_days` is the minimum number of days a
 *   deprecated version stays callable (default 90); `removal_date` is the computed
 *   `deprecated_at + grace_period_days` snapshot, after which an admin may remove
 *   the version. A non-deprecated version has deprecated_at / replaced_by /
 *   removal_date all NULL; grace_period_days always has a value (default 90) but
 *   is only semantically meaningful once deprecated_at is set.
 *
 * NOTE: No PL/pgSQL triggers / DO $$ blocks for `updated_at` — the RDS Data API
 * migration runner's statement splitter cannot handle dollar-quoted blocks (see
 * migration 079). `updated_at` is maintained by application code via Drizzle
 * `.set({ updatedAt: new Date() })`.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Default deprecation grace period (days) — the minimum window a deprecated tool
 * version stays callable before an admin may remove it (Issue #927). Per-tool
 * overridable via `grace_period_days`. 90 days is the issue-confirmed default.
 */
export const DEFAULT_GRACE_PERIOD_DAYS = 90;

/** Surfaces a catalog tool can be exposed on. */
export type ToolSurface = "mcp" | "ai_sdk" | "rest" | "internal";

/**
 * Source of a catalog tool record.
 * - `code` — manifest-managed (lib/tools/catalog/manifest.ts).
 * - `assistant` / `skill` — dynamically registered via their lifecycle hooks.
 * - `retired` — was code-managed but removed from the manifest; kept inactive so a
 *   later manifest re-add can re-claim ownership. Never a live tool.
 */
export type ToolCatalogSource = "code" | "assistant" | "skill" | "retired";

export const toolCatalog = pgTable(
  "tool_catalog",
  {
    id: serial("id").primaryKey(),
    identifier: varchar("identifier", { length: 150 }).notNull(),
    version: varchar("version", { length: 20 }).default("v1").notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    description: text("description").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
    surfaces: jsonb("surfaces").$type<ToolSurface[]>().default([]).notNull(),
    requiredScopes: jsonb("required_scopes")
      .$type<string[]>()
      .default([])
      .notNull(),
    agentCallable: boolean("agent_callable").default(true).notNull(),
    source: varchar("source", { length: 20 })
      .$type<ToolCatalogSource>()
      .default("code")
      .notNull(),
    handlerRef: varchar("handler_ref", { length: 200 }),
    isActive: boolean("is_active").default(true).notNull(),
    deprecatedAt: timestamp("deprecated_at"),
    replacedBy: varchar("replaced_by", { length: 200 }),
    /**
     * Computed `deprecated_at + grace_period_days` snapshot, set when a version is
     * deprecated. After this date an admin may remove the version. NULL while the
     * version is not deprecated. (Issue #927.)
     */
    removalDate: timestamp("removal_date"),
    /**
     * Minimum days a deprecated version stays callable before removal. Snapshotted
     * at deprecation time so changing the global default never retroactively
     * shortens an in-flight grace window. Default 90. (Issue #927.)
     */
    gracePeriodDays: integer("grace_period_days")
      .default(DEFAULT_GRACE_PERIOD_DAYS)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // A logical tool is uniquely identified by (identifier, version). Mirrors the
    // UNIQUE constraint in the migration so the Drizzle schema stays the faithful
    // source of truth for drift detection / regeneration.
    uniqueIndex("tool_catalog_identifier_version_key").on(
      t.identifier,
      t.version
    ),
    check(
      "tool_catalog_source_check",
      sql`${t.source} IN ('code', 'assistant', 'skill', 'retired')`
    ),
    index("idx_tool_catalog_identifier").on(t.identifier),
    index("idx_tool_catalog_source").on(t.source),
    index("idx_tool_catalog_is_active").on(t.isActive),
  ]
);

export type ToolCatalogRow = typeof toolCatalog.$inferSelect;
export type NewToolCatalogRow = typeof toolCatalog.$inferInsert;
