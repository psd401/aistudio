/**
 * Unified Tool Catalog — shared utilities
 *
 * Issue #924 (Epic #922, workstream #2). Small pure helpers shared by the
 * manifest (`manifest.ts`) and the runtime catalog (`catalog.ts`) to avoid
 * duplicating version-ordering logic. (PR #1032 review finding #6.)
 */

/**
 * Numeric rank of a version string. Versions are `v1`, `v2`, ...; the trailing
 * digits are parsed numerically. Non-`vN` values return `NaN` so the comparator
 * can fall back to a deterministic string compare.
 *
 * The token grammar is strict: versions start at `v1` and carry no leading
 * zeros. `v0` and `v01` are rejected (NaN) — `parseToolRef` treats a NaN rank
 * as a malformed pin, matching the REST route's `normalizeVersionParam`, so the
 * two validation layers cannot disagree (epic #922 audit).
 */
export function versionRank(version: string): number {
  const m = /^v([1-9]\d*)$/.exec(version);
  return m ? Number(m[1]) : Number.NaN;
}

/**
 * Order two versions so the highest sorts first (negative = `a` is newer).
 * Numeric (`vN`) versions sort ahead of non-numeric ones; ties between two
 * non-numeric versions fall back to a reverse locale compare so ordering stays
 * deterministic.
 */
export function compareVersionsDesc(a: string, b: string): number {
  const ra = versionRank(a);
  const rb = versionRank(b);
  if (!Number.isNaN(ra) && !Number.isNaN(rb)) return rb - ra;
  if (!Number.isNaN(ra)) return -1; // numeric versions sort ahead of non-numeric
  if (!Number.isNaN(rb)) return 1;
  return b.localeCompare(a);
}
