/**
 * Tool catalog → REST response serializer (Issue #927).
 *
 * Projects a runtime {@link ToolCatalogEntry} into the public JSON shape the
 * `/api/v1/tools/*` endpoints return. Pure + dependency-light so it is shared by
 * both the single-tool and specific-version routes and is unit-testable without a
 * request. Deliberately omits internal-only fields (`handlerRef`,
 * `surfaceScopes`) that should not leak to API consumers.
 */

import { versionRank } from "@/lib/tools/catalog/utils";
import type { ToolCatalogEntry } from "@/lib/tools/catalog/types";

/** Public REST shape of a single tool version. */
export interface SerializedToolVersion {
  identifier: string;
  version: string;
  name: string;
  description: string;
  inputSchema: ToolCatalogEntry["inputSchema"];
  outputSchema?: Record<string, unknown>;
  surfaces: string[];
  requiredScopes: string[];
  agentCallable: boolean;
  isActive: boolean;
  deprecated: boolean;
  deprecatedAt: string | null;
  replacedBy: string | null;
  removalDate: string | null;
}

/** Serialize a runtime catalog entry into its public REST shape. */
export function serializeToolEntry(
  entry: ToolCatalogEntry
): SerializedToolVersion {
  return {
    identifier: entry.identifier,
    version: entry.version,
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    surfaces: entry.surfaces,
    requiredScopes: entry.requiredScopes,
    agentCallable: entry.agentCallable,
    isActive: entry.isActive,
    deprecated: entry.deprecatedAt != null,
    deprecatedAt: entry.deprecatedAt ? entry.deprecatedAt.toISOString() : null,
    replacedBy: entry.replacedBy ?? null,
    removalDate: entry.removalDate ? entry.removalDate.toISOString() : null,
  };
}

/**
 * Normalize a REST `{version}` path param into the canonical `vN` form. Accepts
 * either `v2` or a bare `2`. Returns `null` for anything that is not a positive
 * integer version (so the route can reject with a 400).
 */
export function normalizeVersionParam(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Already a vN token? Require rank >= 1 to reject "v0".
  if (!Number.isNaN(versionRank(trimmed)) && versionRank(trimmed) >= 1) return trimmed;
  // Bare positive integer -> vN.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 1) return `v${n}`;
  }
  return null;
}
