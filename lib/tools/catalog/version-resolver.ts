/**
 * Tool version resolution + deprecation policy (Issue #927).
 *
 * Layered on top of the unified tool catalog (#924). Pure, DB-free helpers so the
 * versioning contract is unit-testable in isolation:
 *
 *   - parse `identifier@version` addressing (`documents.create@v1`)
 *   - resolve the latest NON-DEPRECATED version when no version is pinned
 *   - reject a pinned version that does not exist or has been removed
 *   - classify a version's deprecation state (live / deprecated / past removal)
 *
 * The catalog (`catalog.ts`) consumes these to answer `resolve()` /
 * `getVersion()` and to decide when to emit a deprecated-tool telemetry event.
 *
 * Terminology:
 *   - "removed" = the version row no longer exists in the catalog. A consumer
 *     pinned to it gets a clear error (handled by the catalog, not here).
 *   - "deprecated" = `deprecatedAt` is set; still callable, emits a warning.
 *   - "past removal date" = deprecated AND `removalDate` <= now; eligible for an
 *     admin to hard-remove, but still callable until they do.
 */

import { compareVersionsDesc, versionRank } from "@/lib/tools/catalog/utils";

/**
 * Minimal version-bearing shape the resolver operates on. Both
 * `ToolCatalogEntry` and a raw `tool_catalog` row satisfy it, so the resolver
 * stays decoupled from either concrete type.
 */
export interface VersionedEntry {
  identifier: string;
  version: string;
  /** Set when the version is deprecated (still callable). */
  deprecatedAt?: Date | null;
  /** Computed removal date snapshot; set alongside `deprecatedAt`. */
  removalDate?: Date | null;
  /** Successor `identifier@version` a deprecated version points at. */
  replacedBy?: string | null;
}

/** A tool reference split into its identifier and optional pinned version. */
export interface ParsedToolRef {
  /** The stable `domain.action` identifier (never includes `@`). */
  identifier: string;
  /** The pinned version (`v1`, `v2`, ...), or `null` when unpinned (latest). */
  version: string | null;
}

/** The maximum number of `@` separators a valid tool reference may contain. */
const MAX_AT_SEPARATORS = 1;

/**
 * Parse a tool reference of the form `identifier` or `identifier@version`.
 *
 * - `documents.create`      -> `{ identifier: "documents.create", version: null }`
 * - `documents.create@v2`   -> `{ identifier: "documents.create", version: "v2" }`
 *
 * The version, when present, MUST be a well-formed `vN` token; a malformed
 * version (`@`, `@v`, `@2`, `@v1@v2`, trailing/leading whitespace that empties a
 * part) yields `null` so the caller can reject the reference rather than silently
 * treating it as unpinned (which would mask a typo'd pin). An empty identifier
 * also yields `null`.
 *
 * @returns the parsed reference, or `null` when the reference is malformed.
 */
export function parseToolRef(ref: string): ParsedToolRef | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;

  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount > MAX_AT_SEPARATORS) return null;

  if (atCount === 0) {
    return { identifier: trimmed, version: null };
  }

  const [rawIdentifier, rawVersion] = trimmed.split("@");
  const identifier = rawIdentifier?.trim();
  const version = rawVersion?.trim();
  // Both sides must be non-empty, and the version must be a valid vN token.
  if (!identifier || !version) return null;
  if (Number.isNaN(versionRank(version))) return null;
  return { identifier, version };
}

/**
 * Format an identifier + version back into the canonical `identifier@version`
 * addressing string (the form stored in `replaced_by` and used by callers).
 */
export function formatToolRef(identifier: string, version: string): string {
  return `${identifier}@${version}`;
}

/** True when an entry is deprecated (its `deprecatedAt` is set). */
export function isDeprecated(entry: VersionedEntry): boolean {
  return entry.deprecatedAt != null;
}

/**
 * True when a deprecated entry is past its removal date relative to `now`. A
 * non-deprecated entry, or a deprecated entry with no `removalDate`, is never
 * past removal. (`removalDate` is always set alongside `deprecatedAt` by the
 * deprecation action, but the resolver tolerates a missing one defensively.)
 */
export function isPastRemovalDate(
  entry: VersionedEntry,
  now: Date = new Date()
): boolean {
  if (!isDeprecated(entry) || entry.removalDate == null) return false;
  return entry.removalDate.getTime() <= now.getTime();
}

/**
 * Of the entries for one identifier, pick the latest NON-DEPRECATED version.
 *
 * Falls back to the latest deprecated version ONLY when every version is
 * deprecated (so an all-deprecated tool is still resolvable to *something*
 * rather than disappearing). Returns `undefined` when the list is empty.
 *
 * Callers pass entries that already share an identifier; this does not filter by
 * identifier itself.
 */
export function pickLatestNonDeprecated<T extends VersionedEntry>(
  entries: readonly T[]
): T | undefined {
  if (entries.length === 0) return undefined;
  const live = entries.filter((e) => !isDeprecated(e));
  const pool = live.length > 0 ? live : entries;
  // compareVersionsDesc sorts highest-first; reduce keeps the first (highest).
  return pool.reduce((best, e) =>
    compareVersionsDesc(e.version, best.version) < 0 ? e : best
  );
}

/** Outcome discriminant of {@link resolveVersion}. */
export type VersionResolution<T extends VersionedEntry> =
  | { ok: true; entry: T; deprecated: boolean }
  | { ok: false; reason: "unknown_identifier" | "unknown_version" };

/**
 * Resolve a parsed tool reference against the candidate entries for its
 * identifier.
 *
 * - Unpinned (`version: null`): resolves to the latest non-deprecated version
 *   (see {@link pickLatestNonDeprecated}).
 * - Pinned (`version: "vN"`): resolves to that exact version if present;
 *   otherwise `unknown_version` (a removed/never-existed pin — the caller maps
 *   this to a clear, actionable error for the pinned consumer).
 * - No candidates at all: `unknown_identifier`.
 *
 * `candidates` MUST already be the entries whose identifier equals
 * `ref.identifier` (the catalog pre-filters by identifier). `deprecated` on a
 * successful resolution lets the caller decide whether to emit a warning event.
 */
export function resolveVersion<T extends VersionedEntry>(
  ref: ParsedToolRef,
  candidates: readonly T[]
): VersionResolution<T> {
  if (candidates.length === 0) {
    return { ok: false, reason: "unknown_identifier" };
  }

  if (ref.version === null) {
    const entry = pickLatestNonDeprecated(candidates);
    // pickLatestNonDeprecated only returns undefined for an empty list, already
    // handled above; this guard satisfies the type narrowing.
    if (!entry) return { ok: false, reason: "unknown_identifier" };
    return { ok: true, entry, deprecated: isDeprecated(entry) };
  }

  const entry = candidates.find((c) => c.version === ref.version);
  if (!entry) {
    return { ok: false, reason: "unknown_version" };
  }
  return { ok: true, entry, deprecated: isDeprecated(entry) };
}

/**
 * Compute the removal date for a version being deprecated now: `deprecatedAt +
 * gracePeriodDays`. Pure so the deprecation action and tests share one formula.
 */
export function computeRemovalDate(
  deprecatedAt: Date,
  gracePeriodDays: number
): Date {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return new Date(deprecatedAt.getTime() + gracePeriodDays * MS_PER_DAY);
}
