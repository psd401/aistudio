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
import type { GrantKind } from "@/lib/content/types";

const VALID_GRANT_KINDS: readonly GrantKind[] = [
  "role",
  "building",
  "department",
  "grade",
  "user",
];
const GRANT_KIND_SET = new Set<string>(VALID_GRANT_KINDS);

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
