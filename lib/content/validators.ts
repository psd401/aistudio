/**
 * Atrium content validators (#1053, Epic #1059)
 *
 * Runtime guards shared by the visibility / publish server actions. Those surfaces
 * receive a widened `string` grant kind (the action / REST / MCP input contract),
 * so it MUST be narrowed at runtime before it reaches the service and the DB enum —
 * a bare `as` cast is a type-system fiction that lets an unexpected value through.
 *
 * Co-located here so `set-visibility` and `publish-document` (and the Phase 5 agent
 * path) share ONE source of truth instead of byte-for-byte copies that silently
 * diverge when a kind is added. The service keeps its own independent guard
 * (`assertValidGrant`) as the last line before the DB — see visibility-service.ts.
 */
import { ValidationError } from "@/lib/content/errors";
import type { GrantKind, VisibilityLevel } from "@/lib/content/types";

const VALID_GRANT_KINDS: readonly GrantKind[] = [
  "role",
  "building",
  "department",
  "grade",
  "user",
];
/**
 * The single membership-test source for grant kinds. Exported so the
 * visibility *service* (`assertValidGrant`, the last guard before the DB enum)
 * can reuse it instead of maintaining a parallel untyped `Set` — a new grant
 * kind then needs editing in exactly one place here, derived from the typed
 * `GrantKind[]` so a missed value is a type error, not a silent gap.
 */
export const GRANT_KIND_SET: ReadonlySet<string> = new Set<string>(
  VALID_GRANT_KINDS
);

/**
 * Narrow a widened `string` grant kind to `GrantKind`, throwing a ValidationError
 * (surfaced as a 400) on an unknown value rather than letting it reach the DB enum.
 */
export function assertGrantKind(kind: string): GrantKind {
  if (!GRANT_KIND_SET.has(kind)) {
    throw new ValidationError(`Invalid visibility grant kind: ${kind}`, { kind });
  }
  return kind as GrantKind;
}

const VALID_VISIBILITY_LEVELS: readonly VisibilityLevel[] = [
  "private",
  "group",
  "internal",
  "public",
];
const VISIBILITY_LEVEL_SET = new Set<string>(VALID_VISIBILITY_LEVELS);

/**
 * Narrow a widened `string` visibility level to `VisibilityLevel`, throwing a
 * ValidationError (surfaced as a 400) on an unknown value rather than letting a
 * bare `as` cast push an unexpected value to the DB enum. Co-located with
 * `assertGrantKind` so the Phase 5 agent/REST path reuses ONE guard instead of
 * a copy-paste that silently diverges when a level is added.
 */
export function assertLevel(level: string): VisibilityLevel {
  if (!VISIBILITY_LEVEL_SET.has(level)) {
    throw new ValidationError(`Invalid visibility level: ${level}`, { level });
  }
  return level as VisibilityLevel;
}
