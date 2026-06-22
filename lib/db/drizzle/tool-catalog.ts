/**
 * Drizzle accessors for the tool catalog version lifecycle (Issue #927).
 *
 * Reads/writes the `tool_catalog` table for the admin version-history UI and the
 * deprecation/removal actions. The runtime catalog (`lib/tools/catalog/catalog.ts`)
 * reads the same table for dispatch; after any write here, callers MUST invalidate
 * the runtime catalog cache (`toolCatalogInstance.invalidate()`) so the change is
 * visible without waiting out the 5-minute TTL.
 *
 * All functions use the executeQuery() wrapper (circuit breaker + retry).
 */

import { and, eq, or, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import {
  toolCatalog,
  psdAgentSkills,
  chainPrompts,
  type ToolCatalogRow,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";

/**
 * Build a predicate matching rows whose JSONB string-array `column` contains the
 * pinned `identifier@version` OR the bare `identifier`. Uses the JSONB containment
 * operator `@>` (a single-element array literal per candidate) rather than the
 * any-key operator `?|` — `?` would be ambiguous with driver parameter syntax, so
 * `@>` keeps the query portable and parameter-safe. Each candidate is passed as a
 * bound parameter cast to a JSONB array.
 */
function jsonbArrayContainsAny(column: AnyColumn, candidates: string[]): SQL {
  const clauses = candidates.map(
    (value) => sql`${column} @> ${JSON.stringify([value])}::jsonb`
  );
  // `or()` of one clause is just that clause; never empty here (callers pass 2).
  return or(...clauses) ?? sql`false`;
}

/**
 * Usage counts for a single tool version (Issue #927). Drives the admin version-
 * history view: which skills and assistant prompts reference this version.
 */
export interface ToolVersionUsage {
  /** Skills whose `allowed_tools` pin `identifier@version` or bare `identifier`. */
  skillCount: number;
  /** Assistant prompts whose `enabled_tools` reference the tool. */
  assistantPromptCount: number;
}

/** A catalog row plus its computed usage counts, for the admin history table. */
export interface ToolVersionWithUsage extends ToolCatalogRow {
  usage: ToolVersionUsage;
}

/** Get every catalog row for an identifier (all versions). */
export async function getToolCatalogVersions(
  identifier: string
): Promise<ToolCatalogRow[]> {
  return executeQuery(
    (db) =>
      db.select().from(toolCatalog).where(eq(toolCatalog.identifier, identifier)),
    "getToolCatalogVersions"
  );
}

/** Get a single catalog row by (identifier, version), or undefined. */
export async function getToolCatalogVersion(
  identifier: string,
  version: string
): Promise<ToolCatalogRow | undefined> {
  const rows = await executeQuery(
    (db) =>
      db
        .select()
        .from(toolCatalog)
        .where(
          and(
            eq(toolCatalog.identifier, identifier),
            eq(toolCatalog.version, version)
          )
        )
        .limit(1),
    "getToolCatalogVersion"
  );
  return rows[0];
}

/**
 * List distinct tool identifiers in the catalog, with their version count and
 * how many versions are deprecated — the top-level admin tool list.
 */
export async function listToolCatalogIdentifiers(): Promise<
  { identifier: string; versionCount: number; deprecatedCount: number }[]
> {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          identifier: toolCatalog.identifier,
          versionCount: sql<number>`count(*)::int`,
          deprecatedCount: sql<number>`count(${toolCatalog.deprecatedAt})::int`,
        })
        .from(toolCatalog)
        .groupBy(toolCatalog.identifier)
        .orderBy(toolCatalog.identifier),
    "listToolCatalogIdentifiers"
  );
  return result;
}

/**
 * Count how many skills reference a tool version. A skill references a version
 * when its `allowed_tools` JSONB array contains either the exact
 * `identifier@version` pin OR the bare `identifier` (which tracks latest — so it
 * counts toward whichever version is currently latest; the caller decides how to
 * attribute "bare" references, here we count them against every version so the
 * admin sees the full blast radius of a change).
 */
async function countSkillUsage(
  identifier: string,
  version: string
): Promise<number> {
  const pinned = `${identifier}@${version}`;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(psdAgentSkills)
        .where(
          jsonbArrayContainsAny(psdAgentSkills.allowedTools, [pinned, identifier])
        ),
    "countSkillUsage"
  );
  return rows[0]?.count ?? 0;
}

/**
 * Count how many assistant chain-prompts reference a tool. Prompts store bare
 * tool names/identifiers in `enabled_tools` (no version pin today), so this
 * matches on the identifier and the `@version` pin form.
 */
async function countAssistantPromptUsage(
  identifier: string,
  version: string
): Promise<number> {
  const pinned = `${identifier}@${version}`;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(chainPrompts)
        .where(
          jsonbArrayContainsAny(chainPrompts.enabledTools, [pinned, identifier])
        ),
    "countAssistantPromptUsage"
  );
  return rows[0]?.count ?? 0;
}

/** Compute usage counts for a single tool version. */
export async function getToolVersionUsage(
  identifier: string,
  version: string
): Promise<ToolVersionUsage> {
  const [skillCount, assistantPromptCount] = await Promise.all([
    countSkillUsage(identifier, version),
    countAssistantPromptUsage(identifier, version),
  ]);
  return { skillCount, assistantPromptCount };
}

/**
 * Get all versions of a tool with usage counts attached (admin history view).
 *
 * Uses 2 DB queries (skills + assistant prompts) regardless of how many versions
 * the tool has, then counts per version in application code. This replaces the
 * previous O(2N) query pattern that fired one query per version.
 */
export async function getToolVersionsWithUsage(
  identifier: string
): Promise<ToolVersionWithUsage[]> {
  const versions = await getToolCatalogVersions(identifier);
  if (versions.length === 0) return [];

  // Build candidate set: every pinned reference + the bare identifier.
  // The bare identifier counts toward every version (blast-radius view for admins).
  const candidates = [
    ...versions.map((v) => `${identifier}@${v.version}`),
    identifier,
  ];

  const [skillRows, promptRows] = await Promise.all([
    executeQuery(
      (db) =>
        db
          .select({ allowedTools: psdAgentSkills.allowedTools })
          .from(psdAgentSkills)
          .where(jsonbArrayContainsAny(psdAgentSkills.allowedTools, candidates)),
      "getSkillsForToolUsage"
    ),
    executeQuery(
      (db) =>
        db
          .select({ enabledTools: chainPrompts.enabledTools })
          .from(chainPrompts)
          .where(jsonbArrayContainsAny(chainPrompts.enabledTools, candidates)),
      "getPromptsForToolUsage"
    ),
  ]);

  return versions.map((row) => {
    const vPin = `${identifier}@${row.version}`;
    const skillCount = skillRows.filter(
      (s) => s.allowedTools.includes(vPin) || s.allowedTools.includes(identifier)
    ).length;
    const assistantPromptCount = promptRows.filter(
      (p) =>
        (p.enabledTools ?? []).includes(vPin) ||
        (p.enabledTools ?? []).includes(identifier)
    ).length;
    return { ...row, usage: { skillCount, assistantPromptCount } };
  });
}

/**
 * Mark a tool version deprecated. Sets `deprecated_at` (if not already set),
 * `replaced_by`, `grace_period_days`, and the computed `removal_date`. Idempotent
 * on `deprecated_at`: re-deprecating keeps the original timestamp/removal date so
 * the grace clock is not reset. Returns the updated row.
 *
 * @throws {DatabaseError} when the (identifier, version) does not exist.
 */
export async function deprecateToolVersion(params: {
  identifier: string;
  version: string;
  replacedBy: string | null;
  gracePeriodDays: number;
  deprecatedAt: Date;
  removalDate: Date;
}): Promise<ToolCatalogRow> {
  const { identifier, version, replacedBy, gracePeriodDays, deprecatedAt, removalDate } =
    params;
  const result = await executeQuery(
    (db) =>
      db
        .update(toolCatalog)
        .set({
          // COALESCE keeps the original deprecation timestamp/removal date if the
          // row is already deprecated (don't restart the grace clock).
          // grace_period_days is NOT NULL (default 90), so COALESCE would always
          // keep the existing value — use CASE WHEN instead to snapshot the
          // admin-supplied value only on the first deprecation.
          deprecatedAt: sql`COALESCE(${toolCatalog.deprecatedAt}, ${deprecatedAt})`,
          removalDate: sql`COALESCE(${toolCatalog.removalDate}, ${removalDate})`,
          gracePeriodDays: sql`CASE WHEN ${toolCatalog.deprecatedAt} IS NULL THEN ${gracePeriodDays} ELSE ${toolCatalog.gracePeriodDays} END`,
          // replaced_by is always updatable (an admin may set/correct the successor).
          replacedBy: replacedBy ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(toolCatalog.identifier, identifier),
            eq(toolCatalog.version, version)
          )
        )
        .returning(),
    "deprecateToolVersion"
  );
  if (result.length === 0) {
    throw ErrorFactories.dbRecordNotFound(
      "tool_catalog",
      `${identifier}@${version}`
    );
  }
  return result[0];
}

/**
 * Clear a tool version's deprecation (un-deprecate). Nulls all four lifecycle
 * fields and resets the grace period to the default. Returns the updated row.
 *
 * NOTE: resetting `grace_period_days` to the default is intentional. The grace
 * period is meaningless while a version is live, and a subsequent re-deprecation
 * always snapshots a fresh grace period from the admin's input (or the default if
 * none is supplied — see {@link deprecateToolVersion}'s `CASE WHEN ... IS NULL`).
 * So an admin who originally chose a custom grace period (e.g. 180 days) and then
 * undeprecates must re-specify it on re-deprecation; it is NOT preserved across an
 * undeprecate. (#1044 review observation.)
 *
 * @throws {DatabaseError} when the (identifier, version) does not exist.
 */
export async function undeprecateToolVersion(
  identifier: string,
  version: string,
  defaultGracePeriodDays: number
): Promise<ToolCatalogRow> {
  const result = await executeQuery(
    (db) =>
      db
        .update(toolCatalog)
        .set({
          // ?? null so the clearable timestamps are actually persisted as NULL.
          deprecatedAt: null,
          removalDate: null,
          replacedBy: null,
          gracePeriodDays: defaultGracePeriodDays,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(toolCatalog.identifier, identifier),
            eq(toolCatalog.version, version)
          )
        )
        .returning(),
    "undeprecateToolVersion"
  );
  if (result.length === 0) {
    throw ErrorFactories.dbRecordNotFound(
      "tool_catalog",
      `${identifier}@${version}`
    );
  }
  return result[0];
}

/**
 * Hard-remove a tool version (delete the row). Only valid for non-code tools or
 * deprecated rows past their removal date — the action layer enforces that
 * policy; this is the raw delete. Returns the deleted row, or undefined if it did
 * not exist.
 */
export async function removeToolVersion(
  identifier: string,
  version: string
): Promise<ToolCatalogRow | undefined> {
  const result = await executeQuery(
    (db) =>
      db
        .delete(toolCatalog)
        .where(
          and(
            eq(toolCatalog.identifier, identifier),
            eq(toolCatalog.version, version)
          )
        )
        .returning(),
    "removeToolVersion"
  );
  return result[0];
}

/**
 * Transactionally remove a tool version under a removal policy (Issue #927).
 *
 * Reads the row `FOR UPDATE` inside the transaction, runs the caller's policy
 * assertion against the locked row, then deletes it — closing the read-then-delete
 * TOCTOU window the separate {@link getToolCatalogVersion} + {@link removeToolVersion}
 * calls left open. Without the lock, a concurrent admin deletion between the
 * existence check and the delete would surface as a confusing undefined-state
 * success; here the second remover blocks on the lock, then re-reads the row gone
 * and gets a clean `dbRecordNotFound`. (#1044 review.)
 *
 * `assertRemovable` enforces the policy (throws when removal is disallowed) and
 * returns the audit's `pastRemoval` flag, which is threaded back to the caller.
 *
 * @throws {DatabaseError} when the (identifier, version) does not exist.
 */
export async function removeToolVersionWithPolicy(
  identifier: string,
  version: string,
  assertRemovable: (existing: ToolCatalogRow) => boolean
): Promise<{ removed: ToolCatalogRow; pastRemoval: boolean }> {
  return executeTransaction(async (tx) => {
    const locked = await tx
      .select()
      .from(toolCatalog)
      .where(
        and(
          eq(toolCatalog.identifier, identifier),
          eq(toolCatalog.version, version)
        )
      )
      .limit(1)
      .for("update");
    const existing = locked[0];
    if (!existing) {
      throw ErrorFactories.dbRecordNotFound(
        "tool_catalog",
        `${identifier}@${version}`
      );
    }

    const pastRemoval = assertRemovable(existing);

    const deleted = await tx
      .delete(toolCatalog)
      .where(
        and(
          eq(toolCatalog.identifier, identifier),
          eq(toolCatalog.version, version)
        )
      )
      .returning();
    // The row is lock-held from the SELECT above, so the delete cannot race; a
    // missing return here would indicate a logic error, not a concurrent delete.
    if (!deleted[0]) {
      throw ErrorFactories.dbRecordNotFound(
        "tool_catalog",
        `${identifier}@${version}`
      );
    }
    return { removed: deleted[0], pastRemoval };
  }, "removeToolVersionWithPolicy");
}
