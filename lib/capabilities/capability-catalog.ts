/**
 * Capability Catalog — a live, deterministic projection of AI Studio's own
 * source-of-truth registries into one "what can this platform do?" view.
 *
 * Issue #1100 (Epic #922). This is the AWARENESS/catalog layer: it lets the
 * OpenClaw agent (and any scoped MCP caller) understand what AI Studio can do —
 * both the actions it can invoke over `/api/mcp` and the web-app features it
 * should steer a human toward — without any hand-maintained list that can drift.
 *
 * ## Freshness engine
 *
 * The catalog is rebuilt on every call from the three registries a developer
 * *must* update to ship a feature:
 *   - `TOOL_MANIFEST`      (invocable tools)        → {@link CapabilityCatalog.actions}
 *   - `CAPABILITY_MANIFEST`(role-gated UI features) → {@link CapabilityCatalog.features}
 *   - `API_SCOPES`/`ROLE_SCOPES` (API-key scopes)   → {@link CapabilityCatalog.scopes}
 *
 * There is no cached artifact and no second list to maintain: adding an entry to
 * any of those registries appears here automatically, so the projection can never
 * fall behind the deployed code.
 *
 * ## Two distinct namespaces (do NOT collapse)
 *
 * Per `docs/architecture/capabilities-and-scopes.md`, **capabilities** (role-gated
 * UI features for humans) and **scopes** (API-key permissions for programmatic
 * callers) are separate identifier namespaces. This builder keeps them in separate
 * sections and never cross-maps a capability identifier to a scope. The `scopes`
 * section is a *reference* the agent can use to explain access requirements, not a
 * per-feature scope binding.
 *
 * ## Edge-safety
 *
 * This module reads ONLY pure-metadata modules (`TOOL_MANIFEST`,
 * `CAPABILITY_MANIFEST`, `API_SCOPES`/`ROLE_SCOPES`). It must NEVER import a tool
 * handler, the runtime catalog, the DB, or anything that transitively pulls
 * `node:crypto` — the same rule documented at `lib/tools/catalog/manifest.ts`.
 * Keeping it pure also makes it deterministic (no DB round-trip), which is what
 * the committed drift-check (`scripts/capabilities/generate-catalog.ts`) relies on.
 */

import { CAPABILITY_MANIFEST } from "@/lib/capabilities/manifest";
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest";
import { compareVersionsDesc } from "@/lib/tools/catalog/utils";
import type { ToolSurface } from "@/lib/tools/catalog/types";
import { API_SCOPES, ROLE_SCOPES } from "@/lib/api-keys/scopes";

/**
 * An invocable AI Studio action, projected from `TOOL_MANIFEST`. `agentInvocable`
 * is true when the tool is exposed on the `mcp` surface — the only surface the
 * OpenClaw agent can reach (it POSTs JSON-RPC to `/api/mcp`). Actions that are
 * `internal`/`ai_sdk`/`rest`-only are still listed (so the agent knows they exist)
 * but flagged `agentInvocable: false`.
 */
export interface CapabilityCatalogAction {
  /** Stable `domain.action` identifier (e.g. `assistants.execute`). */
  identifier: string;
  /** MCP wire / model-facing tool name (e.g. `execute_assistant`). */
  name: string;
  /** Model/human-readable description. */
  description: string;
  /** Surfaces this action is exposed on. */
  surfaces: ToolSurface[];
  /** Base API scope(s) a caller must hold to invoke it (the MCP-surface scopes). */
  requiredScopes: string[];
  /** True when the action writes/deletes/has external side effects. */
  destructive: boolean;
  /** True when reachable over `/api/mcp` (surface includes `mcp`). */
  agentInvocable: boolean;
}

/**
 * A role-gated UI feature, projected from `CAPABILITY_MANIFEST`. The agent cannot
 * invoke these (they are human-driven web-app features); it steers the user to them.
 */
export interface CapabilityCatalogFeature {
  /** Stable capability identifier checked by `hasCapabilityAccess()`. */
  identifier: string;
  /** Human-readable feature name. */
  name: string;
  /** Description of the feature. */
  description: string;
  /** Role names granted the feature by default (seed-time). */
  defaultRoles: string[];
  /** Always true: features are human-driven UI, not agent-invocable. */
  humanDriven: true;
}

/**
 * An API-key scope, projected from `API_SCOPES` + `ROLE_SCOPES`. Reference only —
 * lets the agent explain which roles hold which programmatic permission.
 */
export interface CapabilityCatalogScope {
  /** The scope string (e.g. `assistants:execute`). */
  scope: string;
  /** Human-readable description of what the scope grants. */
  description: string;
  /** Role names that hold this scope (from `ROLE_SCOPES`). */
  roles: string[];
}

/** The unified capability catalog returned by {@link buildCapabilityCatalog}. */
export interface CapabilityCatalog {
  /** Counts of what this response contains (0 for omitted sections). */
  summary: {
    actions: number;
    features: number;
    scopes: number;
    /** Subset of `actions` reachable over `/api/mcp`. */
    agentInvocableActions: number;
  };
  /** Invocable actions (present unless `section` narrows them out). */
  actions?: CapabilityCatalogAction[];
  /** Human-driven UI features (present unless `section` narrows them out). */
  features?: CapabilityCatalogFeature[];
  /** Scope reference (present unless `section` narrows them out). */
  scopes?: CapabilityCatalogScope[];
}

/** Which section(s) to include. Defaults to `all`. */
export type CapabilityCatalogSection = "actions" | "features" | "scopes" | "all";

/** Options for {@link buildCapabilityCatalog}. */
export interface BuildCapabilityCatalogOptions {
  /** Limit the response to one section (default `all`). */
  section?: CapabilityCatalogSection;
  /** Only include actions exposed on this surface (does not affect features/scopes). */
  surface?: ToolSurface;
  /** Case-insensitive substring filter across identifier/name/description/scope. */
  query?: string;
}

/**
 * Collapse `TOOL_MANIFEST` to one entry per identifier, keeping the highest
 * version. All manifest entries are `v1` today, but this keeps the projection
 * correct once multiple versions of a tool coexist.
 */
function latestActionsPerIdentifier(): CapabilityCatalogAction[] {
  const byIdentifier = new Map<string, (typeof TOOL_MANIFEST)[number]>();
  for (const entry of TOOL_MANIFEST) {
    const existing = byIdentifier.get(entry.identifier);
    if (
      !existing ||
      compareVersionsDesc(entry.version ?? "v1", existing.version ?? "v1") < 0
    ) {
      byIdentifier.set(entry.identifier, entry);
    }
  }
  return [...byIdentifier.values()].map((entry) => ({
    identifier: entry.identifier,
    name: entry.name,
    description: entry.description,
    surfaces: entry.surfaces,
    requiredScopes: entry.requiredScopes,
    destructive: entry.destructive ?? false,
    agentInvocable: entry.surfaces.includes("mcp"),
  }));
}

/** Project `CAPABILITY_MANIFEST` into feature entries. */
function buildFeatures(): CapabilityCatalogFeature[] {
  return CAPABILITY_MANIFEST.map((entry) => ({
    identifier: entry.identifier,
    name: entry.name,
    description: entry.description,
    defaultRoles: entry.defaultRoles ?? [],
    humanDriven: true as const,
  }));
}

/**
 * Project `API_SCOPES` + `ROLE_SCOPES` into scope reference entries, annotating
 * each scope with the roles that hold it. Role order follows `ROLE_SCOPES` key
 * order (deterministic).
 */
function buildScopes(): CapabilityCatalogScope[] {
  const roleNames = Object.keys(ROLE_SCOPES);
  return (Object.entries(API_SCOPES) as [string, string][]).map(
    ([scope, description]) => ({
      scope,
      description,
      roles: roleNames.filter((role) =>
        (ROLE_SCOPES[role] as string[]).includes(scope)
      ),
    })
  );
}

/** Lowercased substring predicate over a set of fields. */
function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = query.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(q));
}

/**
 * Build the capability catalog from AI Studio's live registries.
 *
 * Deterministic: identical registries + options always produce byte-identical
 * output (arrays sorted by identifier/scope; no timestamps), which the committed
 * drift-check depends on. Reads pure metadata only — safe to call on any runtime.
 */
export function buildCapabilityCatalog(
  opts: BuildCapabilityCatalogOptions = {}
): CapabilityCatalog {
  const section = opts.section ?? "all";
  const wantActions = section === "all" || section === "actions";
  const wantFeatures = section === "all" || section === "features";
  const wantScopes = section === "all" || section === "scopes";

  let actions = wantActions ? latestActionsPerIdentifier() : [];
  let features = wantFeatures ? buildFeatures() : [];
  let scopes = wantScopes ? buildScopes() : [];

  if (opts.surface) {
    const surface = opts.surface;
    actions = actions.filter((a) => a.surfaces.includes(surface));
  }

  if (opts.query) {
    const query = opts.query;
    actions = actions.filter((a) =>
      matchesQuery(query, a.identifier, a.name, a.description)
    );
    features = features.filter((f) =>
      matchesQuery(query, f.identifier, f.name, f.description)
    );
    scopes = scopes.filter((s) => matchesQuery(query, s.scope, s.description));
  }

  // Deterministic ordering so the generated catalog file (and the drift-check)
  // is stable regardless of manifest declaration order.
  actions.sort((a, b) => a.identifier.localeCompare(b.identifier));
  features.sort((a, b) => a.identifier.localeCompare(b.identifier));
  scopes.sort((a, b) => a.scope.localeCompare(b.scope));

  return {
    summary: {
      actions: actions.length,
      features: features.length,
      scopes: scopes.length,
      agentInvocableActions: actions.filter((a) => a.agentInvocable).length,
    },
    ...(wantActions ? { actions } : {}),
    ...(wantFeatures ? { features } : {}),
    ...(wantScopes ? { scopes } : {}),
  };
}
