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
import {
  PUBLISH_DESTINATIONS,
  type PublishDestination,
} from "@/lib/content/publish-adapters/types";
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
/**
 * The single membership-test source for visibility levels. Exported so the
 * visibility *service* (`setLevelInTx`, the last guard before the DB enum) reuses
 * it instead of maintaining a parallel untyped `Set` — adding a level then edits
 * exactly one place, derived from the typed `VisibilityLevel[]` so a missed value
 * is a type error, not a silent gap where one code path accepts a new level the
 * other still rejects.
 */
export const VISIBILITY_LEVEL_SET: ReadonlySet<string> = new Set<string>(
  VALID_VISIBILITY_LEVELS
);

/**
 * A positive-integer ID string (no leading zeros, no sign, no spaces). The single
 * source of truth for `user`-grant value validation, shared by the service's
 * last-line guard (`assertValidGrant`) and the client-side editor (VisibilityChip)
 * so the two never diverge — a tightened server regex with a looser client check
 * would surface a confusing 400 on save with no prior warning.
 */
export const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

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

/**
 * The FULL set of destinations `publishService.publish` accepts, DERIVED from
 * the canonical `PUBLISH_DESTINATIONS` list in `publish-adapters/types.ts` (the
 * array `PublishDestination` itself is derived from) — so a newly added
 * destination is a member here in the same edit, never a silent gap. Exported
 * (like `GRANT_KIND_SET`) so the §26.4 approval-replay path re-validates the
 * destination it reads back out of the stored jsonb context while keeping its
 * own error shape (`ErrorFactories.invalidInput`).
 */
export const PUBLISH_DESTINATION_SET: ReadonlySet<string> = new Set<string>(
  PUBLISH_DESTINATIONS
);

/**
 * Type-guard form of `PUBLISH_DESTINATION_SET` for callers that keep their own
 * error type/shape (the approvals replay throws `ErrorFactories.invalidInput`,
 * not `ValidationError`) — the membership test still comes from ONE place.
 */
export function isPublishDestination(
  value: string
): value is PublishDestination {
  return PUBLISH_DESTINATION_SET.has(value);
}

/**
 * The destinations the in-app editor surface may publish to / unpublish from.
 * Deliberately EXCLUDES `okf` (the Phase 8 portable-bundle export is an API/MCP
 * surface by design, not an editor button) — a runtime-validated subset of the
 * service's `PublishDestination`.
 */
export type EditorPublishDestination = Exclude<PublishDestination, "okf">;

/**
 * DERIVED from the canonical list (full set minus the explicit `okf` exclusion)
 * rather than hand-listed, so the editor surface and the service can never
 * drift: a destination added to `PUBLISH_DESTINATIONS` flows here automatically,
 * and excluding it from the editor is a deliberate edit to the filter AND the
 * `EditorPublishDestination` type together (the type predicate keeps the two in
 * lockstep — a filter that excluded a non-`okf` value would no longer typecheck
 * as covering `Exclude<PublishDestination, "okf">`).
 */
const EDITOR_PUBLISH_DESTINATIONS: readonly EditorPublishDestination[] =
  PUBLISH_DESTINATIONS.filter(
    (d): d is EditorPublishDestination => d !== "okf"
  );

/** Membership set for `assertEditorDestination`; exported for the editor UI. */
export const EDITOR_PUBLISH_DESTINATION_SET: ReadonlySet<string> =
  new Set<string>(EDITOR_PUBLISH_DESTINATIONS);

/**
 * Narrow a widened `string` destination (the action input contract) to an
 * editor-publishable destination, throwing a ValidationError (400) on anything
 * else — including `okf`, which is a valid SERVICE destination but not an
 * editor one. Mirrors `assertLevel`/`assertGrantKind`: a bare `as` cast would
 * let an unexpected value through to the adapter registry. `action` selects the
 * surface's message ("publish" vs "unpublish"), preserving each server action's
 * original error text.
 */
export function assertEditorDestination(
  destination: string,
  action: "publish" | "unpublish"
): EditorPublishDestination {
  if (!EDITOR_PUBLISH_DESTINATION_SET.has(destination)) {
    throw new ValidationError(`Invalid ${action} destination: ${destination}`, {
      destination,
    });
  }
  return destination as EditorPublishDestination;
}
