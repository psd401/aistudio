/**
 * Unified Tool Catalog — runtime
 *
 * Issue #924 (Epic #922, workstream #2). The single runtime entry point every
 * surface (MCP server, AI SDK chat/Nexus, REST, internal agents) uses to answer
 * "what tools exist, who can call them, from which surfaces, with what schema?".
 *
 * Sources merged:
 *   - Code-defined tools from the manifest (`lib/tools/catalog/manifest.ts`).
 *     These carry their in-process `handler` and are always authoritative for
 *     their identifier@version.
 *   - DB-defined tools from `tool_catalog` where `source != 'code'` (assistant-
 *     and skill-derived). Their handlers dispatch via `handlerRef` (e.g.
 *     `assistant:42`), resolved by the caller's dispatcher — not held in process.
 *
 * The DB read is cached with a short TTL (mirroring settings-manager) because the
 * catalog is consulted on every chat message and MCP request. Code-manifest
 * entries need no DB round-trip.
 *
 * Scope filtering generalizes the retired MCP per-tool scope-map pattern to all
 * surfaces: a caller sees a tool only if it holds every `requiredScope` (or the
 * `*` wildcard). `agentOnly` additionally drops `agentCallable = false` tools so
 * internal agent loops cannot invoke human-only / destructive tools.
 */

import { executeQuery } from "@/lib/db/drizzle-client";
import { toolCatalog } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import type { McpToolHandler, McpToolContext } from "@/lib/mcp/types";
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest";
import { compareVersionsDesc } from "@/lib/tools/catalog/utils";
import {
  parseToolRef,
  resolveVersion,
  type VersionResolution,
} from "@/lib/tools/catalog/version-resolver";
import {
  getFriendlyToolName,
  getAllToolNamesForUI,
} from "@/lib/tools/tool-name-mapping";
import type {
  CatalogCallerType,
  CatalogResolution,
  ToolCatalogEntry,
  ToolCatalogFilter,
  ToolDispatchResult,
  ToolManifestEntry,
  ToolSurface,
} from "@/lib/tools/catalog/types";

const log = createLogger({ module: "tool-catalog" });

/** DB cache TTL — matches settings-manager's 5-minute cache. */
const DB_CACHE_TTL_MS = 5 * 60 * 1000;

/** Deprecation lifecycle state for a code-managed row (Issue #927). */
interface CodeDeprecationState {
  deprecatedAt: Date | null;
  replacedBy: string | null;
  removalDate: Date | null;
}

interface DbState {
  /** Non-code (assistant/skill) DB entries, merged into the runtime catalog. */
  entries: ToolCatalogEntry[];
  /**
   * `is_active` state of code-managed rows, keyed by `identifier@version`. Lets an
   * admin disable a code tool in the DB and have the runtime honor it (the manifest
   * projection otherwise always reports a code tool as active). Only rows recorded
   * as inactive are tracked; absence means active.
   */
  inactiveCodeKeys: Set<string>;
  /**
   * Deprecation state of code-managed rows, keyed by `identifier@version` (Issue
   * #927). The manifest projection always reports a code tool as non-deprecated,
   * so an admin's DB-level deprecation of a code tool version is merged in here.
   * Only deprecated rows are tracked; absence means not deprecated.
   */
  deprecatedCodeKeys: Map<string, CodeDeprecationState>;
  /**
   * PUBLISHED input/output schemas of code-managed rows, keyed by
   * `identifier@version` (Issue #927 immutability — PR #1129 review). The sync
   * refuses schema edits to a published version, but code entries are projected
   * from the in-memory manifest — without this override a schema edit that the
   * sync froze in the DB would still be SERVED by tools/list, REST metadata,
   * and model tool schemas. The DB row is the published contract, so it wins.
   */
  codeSchemas: Map<
    string,
    { inputSchema: unknown; outputSchema: Record<string, unknown> | null }
  >;
}

interface DbCache {
  state: DbState;
  expiresAt: number;
}

/** The `identifier@version` key used to dedupe and look up entries. */
function entryKey(identifier: string, version: string): string {
  return `${identifier}@${version}`;
}

/**
 * Parse a `skill:{id}` handlerRef into the skill id, or null when the ref is
 * not a skill ref. Duplicated (trivially) from `skill-tool-executor.ts` so this
 * module does not import it eagerly — the executor's S3/DB graph must stay out
 * of non-Node bundles (same reason `loadHandlers` is lazy).
 */
function parseSkillRef(handlerRef: string | null | undefined): string | null {
  if (!handlerRef || !handlerRef.startsWith("skill:")) return null;
  const id = handlerRef.slice("skill:".length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Project a manifest entry into a runtime catalog entry. `isActive` defaults to
 * true but is overridden to false when an admin has disabled the code row in the
 * DB (passed via `inactiveCodeKeys`), so DB disables are honored at runtime.
 */
function manifestToEntry(
  entry: ToolManifestEntry,
  inactiveCodeKeys: Set<string>,
  deprecatedCodeKeys: Map<string, CodeDeprecationState>,
  codeSchemas: Map<
    string,
    { inputSchema: unknown; outputSchema: Record<string, unknown> | null }
  >
): ToolCatalogEntry {
  const version = entry.version ?? "v1";
  const key = entryKey(entry.identifier, version);
  // A code tool version is never deprecated by the manifest itself; deprecation
  // is a runtime admin (DB) action recorded in deprecatedCodeKeys (#927).
  const deprecation = deprecatedCodeKeys.get(key);
  // Serve the PUBLISHED (DB) schema, not the manifest's: normally identical
  // (the sync reconciles them), but after a refused immutability violation the
  // DB keeps the published contract and this override keeps the runtime serving
  // it (#927 — PR #1129 review). Falls back to the manifest before first sync
  // or on cold-start DB failure (documented degradation).
  const published = codeSchemas.get(key);
  return {
    identifier: entry.identifier,
    version,
    name: entry.name,
    description: entry.description,
    // DB jsonb columns type as unknown; the row was written FROM this same
    // shape by the sync, so the cast mirrors dbRowToEntry's.
    inputSchema: published
      ? (published.inputSchema as ToolCatalogEntry["inputSchema"])
      : entry.inputSchema,
    outputSchema: published
      ? (published.outputSchema ?? undefined)
      : entry.outputSchema,
    surfaces: entry.surfaces,
    requiredScopes: entry.requiredScopes,
    surfaceScopes: entry.surfaceScopes,
    agentCallable: entry.agentCallable ?? true,
    destructive: entry.destructive ?? false,
    source: "code",
    isActive: !inactiveCodeKeys.has(key),
    deprecatedAt: deprecation?.deprecatedAt ?? null,
    replacedBy: deprecation?.replacedBy ?? null,
    removalDate: deprecation?.removalDate ?? null,
    handlerRef: entry.identifier,
    displayName: entry.displayName,
    friendlyName: entry.friendlyName,
    category: entry.category,
    requiredCapabilities: entry.requiredCapabilities,
  };
}

/** Row shape returned by the `tool_catalog` select (Drizzle infers the columns). */
type ToolCatalogDbRow = {
  identifier: string;
  version: string;
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: Record<string, unknown> | null;
  surfaces: ToolSurface[] | null;
  requiredScopes: string[] | null;
  agentCallable: boolean;
  source: ToolCatalogEntry["source"];
  isActive: boolean;
  deprecatedAt: Date | null;
  replacedBy: string | null;
  removalDate: Date | null;
  handlerRef: string | null;
};

/**
 * Project a non-code (assistant/skill) DB row into a runtime catalog entry.
 * Extracted from {@link ToolCatalog.dbState} to keep that method's complexity low.
 */
function dbRowToEntry(r: ToolCatalogDbRow): ToolCatalogEntry {
  return {
    identifier: r.identifier,
    version: r.version,
    name: r.name,
    description: r.description,
    inputSchema:
      (r.inputSchema as ToolCatalogEntry["inputSchema"]) ?? {
        type: "object",
        properties: {},
      },
    outputSchema: r.outputSchema ?? undefined,
    surfaces: r.surfaces ?? [],
    requiredScopes: r.requiredScopes ?? [],
    // No `surfaceScopes` here on purpose: per-surface scope overrides are a
    // manifest (code-tool) concept and have no `tool_catalog` column. DB
    // (assistant/skill) rows use the same scope on every surface.
    agentCallable: r.agentCallable,
    // No `destructive` column on tool_catalog: DB-sourced (assistant/skill) tools
    // default to non-destructive. The destructive gate is a code-tool (manifest)
    // concept for now. (#926.)
    destructive: false,
    source: r.source,
    isActive: r.isActive,
    // Version deprecation lifecycle (#927). Threaded through so the runtime can
    // resolve "latest non-deprecated", emit a deprecation telemetry event at
    // dispatch, and surface the successor to callers.
    deprecatedAt: r.deprecatedAt ?? null,
    replacedBy: r.replacedBy ?? null,
    removalDate: r.removalDate ?? null,
    handlerRef: r.handlerRef ?? undefined,
  };
}

/**
 * Record a code/retired row's runtime-relevant DB state (is_active + deprecation)
 * into the manifest-projection overlays. Extracted from {@link ToolCatalog.dbState}
 * to keep that method's complexity low.
 */
function recordCodeRowState(
  r: ToolCatalogDbRow,
  inactiveCodeKeys: Set<string>,
  deprecatedCodeKeys: Map<string, CodeDeprecationState>,
  codeSchemas: Map<
    string,
    { inputSchema: unknown; outputSchema: Record<string, unknown> | null }
  >
): void {
  const key = entryKey(r.identifier, r.version);
  if (!r.isActive) {
    inactiveCodeKeys.add(key);
  }
  // Merge an admin's DB-level deprecation of a code tool version into the
  // manifest projection (which always reports code as live). (#927.)
  if (r.deprecatedAt) {
    deprecatedCodeKeys.set(key, {
      deprecatedAt: r.deprecatedAt,
      replacedBy: r.replacedBy ?? null,
      removalDate: r.removalDate ?? null,
    });
  }
  // The DB row's schema is the PUBLISHED contract for this version; the
  // manifest projection serves it so a frozen (refused) manifest schema edit is
  // never exposed to callers (#927 immutability — PR #1129 review).
  codeSchemas.set(key, {
    inputSchema: r.inputSchema,
    outputSchema: r.outputSchema,
  });
}

/** True when `scopes` grant access to a tool requiring `requiredScopes`. */
function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  if (scopes.includes("*")) return true;
  // A tool with no required scopes is open to any authenticated caller.
  if (requiredScopes.length === 0) return true;
  return requiredScopes.every((s) => scopes.includes(s));
}

/**
 * Resolve the scopes a caller must hold for a tool on a given surface. When the
 * surface has a `surfaceScopes` override it REPLACES `requiredScopes` (e.g. REST
 * `assistants:execute` vs MCP `mcp:execute_assistant`); otherwise the base
 * `requiredScopes` apply. Omitting the surface yields the base scopes.
 */
function requiredScopesForSurface(
  entry: ToolCatalogEntry,
  surface?: ToolSurface
): string[] {
  const surfaceSpecific = surface ? entry.surfaceScopes?.[surface] : undefined;
  if (surfaceSpecific) {
    return surfaceSpecific;
  }
  return entry.requiredScopes;
}

/**
 * The unified tool catalog. A module-level singleton (`toolCatalogInstance`)
 * holds the DB cache; the manifest is read fresh from the imported constant.
 */
export class ToolCatalog {
  private dbCache: DbCache | null = null;
  /**
   * In-flight DB load. Concurrent callers that arrive while a load is running
   * reuse this promise instead of each issuing their own query — prevents a cache
   * stampede on cold start / after `invalidate()`.
   */
  private dbPromise: Promise<DbState> | null = null;
  /**
   * In-process MCP handlers for code-defined tools, loaded lazily on first
   * dispatch via a dynamic import and then memoized. Kept OUT of the static import
   * graph on purpose: `tool-handlers` transitively pulls the API auth/service
   * layer, which imports `node:crypto`. The boot-time catalog sync imports the
   * manifest, and Next.js compiles that graph for the Edge runtime too — a static
   * handler import there fails the production webpack build with a `node:crypto`
   * UnhandledSchemeError. Resolving at dispatch time (always the Node.js runtime)
   * avoids pulling that graph into any non-Node bundle. (PR #1032 follow-up.)
   */
  private handlersPromise: Promise<Record<string, McpToolHandler>> | null = null;

  /** Lazily import and memoize the code-tool handler map (keyed by wire name). */
  private loadHandlers(): Promise<Record<string, McpToolHandler>> {
    if (!this.handlersPromise) {
      this.handlersPromise = import("@/lib/mcp/tool-handlers").then(
        (m) => m.TOOL_HANDLERS
      );
    }
    return this.handlersPromise;
  }

  /** Manifest-derived runtime entries (no DB round-trip). */
  private manifestEntries(
    inactiveCodeKeys: Set<string>,
    deprecatedCodeKeys: Map<string, CodeDeprecationState>,
    codeSchemas: DbState["codeSchemas"]
  ): ToolCatalogEntry[] {
    return TOOL_MANIFEST.map((e) =>
      manifestToEntry(e, inactiveCodeKeys, deprecatedCodeKeys, codeSchemas)
    );
  }

  /**
   * Load DB state (non-code entries + code-row inactive set), cached with a short
   * TTL. Concurrent callers share one in-flight query. On DB failure, degrades to
   * the last good cache (even if expired) and finally to an empty state, so a
   * transient outage never throws into every chat/MCP request.
   */
  private async dbState(): Promise<DbState> {
    const now = Date.now();
    if (this.dbCache && this.dbCache.expiresAt > now) {
      return this.dbCache.state;
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = (async () => {
      try {
        const rows = await executeQuery(
          (db) => db.select().from(toolCatalog),
          "toolCatalog.loadDbEntries"
        );

        // Code rows are authoritative from the manifest; only merge the dynamic
        // (assistant/skill) rows to avoid double-listing. But still read code
        // rows' is_active so an admin DB disable is honored at runtime.
        const entries: ToolCatalogEntry[] = [];
        const inactiveCodeKeys = new Set<string>();
        const deprecatedCodeKeys = new Map<string, CodeDeprecationState>();
        const codeSchemas: DbState["codeSchemas"] = new Map();
        for (const r of rows as ToolCatalogDbRow[]) {
          // Treat both 'code' and 'retired' rows as code-managed: track their
          // is_active + deprecation state for the manifest projection rather than
          // listing them as standalone (assistant/skill) entries. A retired row
          // is a code tool removed from the manifest; its admin-disabled state
          // must survive a later re-add (PR #1032 review finding #1).
          if (r.source === "code" || r.source === "retired") {
            recordCodeRowState(r, inactiveCodeKeys, deprecatedCodeKeys, codeSchemas);
            continue;
          }
          entries.push(dbRowToEntry(r));
        }

        const state: DbState = {
          entries,
          inactiveCodeKeys,
          deprecatedCodeKeys,
          codeSchemas,
        };
        this.dbCache = { state, expiresAt: Date.now() + DB_CACHE_TTL_MS };
        return state;
      } catch (error) {
        // On DB failure, degrade gracefully rather than throwing and breaking
        // every chat/MCP request. Prefer the last good cache (even expired) over
        // an empty state so a transient outage does not hide assistant/skill
        // tools or spuriously re-enable an admin-disabled code tool.
        if (this.dbCache) {
          log.error("Failed to load DB tool catalog entries; serving last good cache", {
            error: error instanceof Error ? error.message : String(error),
          });
          return this.dbCache.state;
        }
        // Cold start with no warm cache: we cannot read `inactiveCodeKeys`, so
        // every code tool projects as active. This means an admin's DB-level
        // disable of a code tool is NOT honored until the DB recovers and the
        // cache warms. Surface this distinctly so on-call knows admin disables
        // may be temporarily ignored (vs. the warm-cache path, which is safe).
        // (PR #1032 review finding #1.)
        log.error(
          "Failed to load DB tool catalog entries on cold start; admin DB disables NOT honored until DB recovers",
          { error: error instanceof Error ? error.message : String(error) }
        );
        return {
          entries: [],
          inactiveCodeKeys: new Set(),
          deprecatedCodeKeys: new Map(),
          codeSchemas: new Map(),
        };
      } finally {
        this.dbPromise = null;
      }
    })();

    return this.dbPromise;
  }

  /**
   * Invalidate the DB cache (call after assistant/skill catalog writes).
   *
   * Note: clearing `dbPromise` here only detaches the reference — it does not
   * cancel an in-flight `dbState()` query (the underlying fetch cannot be
   * aborted). Callers already `await`ing the prior promise still receive its
   * result, but that result is no longer cached (the load's `finally` nulls
   * `dbPromise` and the cache was cleared), so the next caller issues a fresh
   * query. This is correctness-safe — it only costs an extra round-trip under
   * concurrent invalidations. (PR #1032 review finding #2.)
   */
  invalidate(): void {
    this.dbCache = null;
    this.dbPromise = null;
  }

  /**
   * List catalog tools, optionally filtered by scopes, surface, and
   * agent-callability. Active-only by default. Manifest (code) entries win on an
   * identifier@version collision with a DB row.
   */
  async list(filter: ToolCatalogFilter = {}): Promise<ToolCatalogEntry[]> {
    const { entries: dbEntries, inactiveCodeKeys, deprecatedCodeKeys, codeSchemas } =
      await this.dbState();
    const merged = new Map<string, ToolCatalogEntry>();
    for (const e of dbEntries) {
      merged.set(entryKey(e.identifier, e.version), e);
    }
    // Manifest entries override DB rows for the same key (code is authoritative),
    // but honor an admin's DB is_active=false via inactiveCodeKeys, DB-level
    // deprecation via deprecatedCodeKeys, and the PUBLISHED schema via
    // codeSchemas (#927).
    for (const e of this.manifestEntries(inactiveCodeKeys, deprecatedCodeKeys, codeSchemas)) {
      merged.set(entryKey(e.identifier, e.version), e);
    }

    let entries = [...merged.values()];

    if (!filter.includeInactive) {
      entries = entries.filter((e) => e.isActive);
    }
    if (filter.excludeDeprecated) {
      entries = entries.filter((e) => e.deprecatedAt == null);
    }
    if (filter.surface) {
      entries = entries.filter((e) => e.surfaces.includes(filter.surface!));
    }
    if (filter.scopes) {
      // Bind to a local so TypeScript narrows away `undefined` inside the arrow
      // fn (it doesn't carry the outer `if` guard through the closure boundary).
      const filterScopes = filter.scopes;
      entries = entries.filter((e) =>
        hasRequiredScopes(filterScopes, requiredScopesForSurface(e, filter.surface))
      );
    }
    if (filter.agentOnly) {
      entries = entries.filter((e) => e.agentCallable);
    }

    return entries;
  }

  /**
   * Filter a list of requested AI SDK tool names down to those the catalog
   * exposes on the `ai_sdk` surface AND the caller's scopes permit. This is the
   * server-side scope gate for built-in chat tools (the chat route receives the
   * enabled-tools list from the client, which is otherwise untrusted).
   *
   * Tools not present in the catalog are passed through unchanged — model-
   * capability filtering downstream still applies — so this never regresses an
   * existing tool that has not yet been cataloged. Names from non-`ai_sdk`
   * surfaces (e.g. MCP wire names like `search_decisions`) are also unresolvable
   * here and pass through; provider adapters ignore unrecognized names, so these
   * are inert, but they do appear in the uncataloged pass-through log.
   *
   * @param requested - tool names the caller asked to enable.
   * @param scopes - the caller's granted scopes.
   * @returns the allowed subset of `requested`.
   */
  async filterAiSdkToolNames(
    requested: string[],
    scopes: string[]
  ): Promise<string[]> {
    const aiSdkTools = await this.list({ surface: "ai_sdk" });
    // Index catalog AI SDK tools by wire name. The client may send a friendly
    // alias (e.g. "webSearch") rather than the catalog wire name
    // ("web_search_preview"); normalize through TOOL_NAME_MAPPING so the scope
    // gate is not silently bypassed for aliased tools.
    const byName = new Map(aiSdkTools.map((t) => [t.name, t]));
    // Cap the number of per-name pass-through logs so a client sending many
    // fabricated tool names cannot flood the logs with one `info` line each;
    // overflow is collapsed into a single aggregated warning. The pass-through
    // itself is still bounded by downstream model-capability filtering. (PR
    // #1032 review finding #2.)
    const UNCATALOGED_LOG_CAP = 5;
    const uncataloged: string[] = [];
    const allowed = requested.filter((name) => {
      const entry = byName.get(name) ?? this.resolveAiSdkAlias(name, byName);
      if (!entry) {
        // Not cataloged under any known name -> leave to downstream
        // model-capability filtering. Log at `info` (not `debug`) so the scope
        // bypass is observable in production: operators can monitor the rate of
        // uncataloged tool names reaching the AI SDK surface.
        if (uncataloged.length < UNCATALOGED_LOG_CAP) {
          log.info("Requested tool not in catalog; passing through unscoped", {
            tool: name,
          });
        }
        uncataloged.push(name);
        return true;
      }
      // Route through requiredScopesForSurface (consistent with list() and
      // dispatch()) so a future ai_sdk-surface scope override is honored rather
      // than silently bypassed by reading the base requiredScopes directly.
      return hasRequiredScopes(scopes, requiredScopesForSurface(entry, "ai_sdk"));
    });
    if (uncataloged.length > UNCATALOGED_LOG_CAP) {
      log.warn("Many uncataloged tool names passed through unscoped in one request", {
        total: uncataloged.length,
        logged: UNCATALOGED_LOG_CAP,
        suppressed: uncataloged.length - UNCATALOGED_LOG_CAP,
      });
    }
    return allowed;
  }

  /**
   * Resolve a client-supplied AI SDK tool alias (e.g. "webSearch") to its catalog
   * entry. Walks every provider wire name registered for the friendly name so an
   * OpenAI/Google/Bedrock-specific name also maps back to the same catalog row.
   */
  private resolveAiSdkAlias(
    name: string,
    byName: Map<string, ToolCatalogEntry>
  ): ToolCatalogEntry | undefined {
    const friendly = getFriendlyToolName(name);
    if (!friendly) return undefined;
    // The catalog wire `name` is one of the provider-specific names registered
    // for this friendly tool (e.g. "web_search_preview"). Try every known alias
    // (friendly + each provider wire name) until one matches a catalog entry.
    for (const candidate of getAllToolNamesForUI(friendly)) {
      const entry = byName.get(candidate);
      if (entry) return entry;
    }
    return undefined;
  }

  /**
   * Resolve a single tool by identifier or by name, preferring the highest
   * version when multiple exist for the same identifier.
   *
   * Intentionally includes inactive entries (`includeInactive: true`): callers
   * such as {@link dispatch} need to distinguish "found but disabled" (reject as
   * unknown to avoid leaking tool existence) from "never existed". They re-check
   * `entry.isActive` themselves.
   */
  async get(identifierOrName: string): Promise<ToolCatalogEntry | undefined> {
    const all = await this.list({ includeInactive: true });
    const matches = all.filter(
      (e) => e.identifier === identifierOrName || e.name === identifierOrName
    );
    if (matches.length === 0) return undefined;
    // Prefer identifier matches over name matches, then highest version.
    matches.sort((a, b) => {
      const aId = a.identifier === identifierOrName ? 0 : 1;
      const bId = b.identifier === identifierOrName ? 0 : 1;
      if (aId !== bId) return aId - bId;
      return compareVersionsDesc(a.version, b.version);
    });
    return matches[0];
  }

  /**
   * All catalog versions of a single tool identifier, highest version first
   * (Issue #927). Includes inactive and deprecated versions so the admin version-
   * history view and the version-resolution path see the complete set. Returns an
   * empty array when the identifier is unknown.
   */
  async listVersions(identifier: string): Promise<ToolCatalogEntry[]> {
    const all = await this.list({ includeInactive: true });
    return all
      .filter((e) => e.identifier === identifier)
      .sort((a, b) => compareVersionsDesc(a.version, b.version));
  }

  /**
   * Resolve a tool reference using `identifier@version` addressing (Issue #927).
   *
   * - Unpinned (`documents.create`): resolves to the latest non-deprecated
   *   version, falling back to the latest deprecated version only when every
   *   version is deprecated.
   * - Pinned (`documents.create@v2`): resolves to that exact version, or
   *   `unknown_version` when it has been removed / never existed.
   * - Malformed (`documents.create@2`): `malformed_ref`.
   *
   * Resolution is over the COMPLETE version set (inactive + deprecated included);
   * the caller decides what to do with `entry.isActive` / `deprecated`. When a
   * deprecated version is resolved AND a `context` is supplied, a structured
   * `deprecated_tool_invocation` telemetry event is emitted (fire-and-forget).
   */
  async resolve(
    ref: string,
    context?: { callerType: CatalogCallerType; callerId?: string }
  ): Promise<CatalogResolution> {
    const parsed = parseToolRef(ref);
    if (!parsed) {
      return { ok: false, reason: "malformed_ref" };
    }
    const candidates = await this.listVersions(parsed.identifier);
    const resolution: VersionResolution<ToolCatalogEntry> = resolveVersion(
      parsed,
      candidates
    );
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    if (resolution.deprecated && context) {
      this.emitDeprecationWarning(resolution.entry, context);
    }
    return {
      ok: true,
      entry: resolution.entry,
      deprecated: resolution.deprecated,
    };
  }

  /**
   * Emit a structured `deprecated_tool_invocation` telemetry event (Issue #927).
   * Fire-and-forget: a `log.warn` line (serialized to JSON in prod -> CloudWatch)
   * so we can track which callers still use a deprecated version, without adding
   * latency to the invocation path. Safe to call repeatedly.
   */
  private emitDeprecationWarning(
    entry: ToolCatalogEntry,
    context: { callerType: CatalogCallerType; callerId?: string }
  ): void {
    log.warn("deprecated_tool_invocation", {
      tool: `${entry.identifier}@${entry.version}`,
      identifier: entry.identifier,
      version: entry.version,
      callerType: context.callerType,
      callerId: context.callerId ?? null,
      replacedBy: entry.replacedBy ?? null,
      deprecatedAt: entry.deprecatedAt
        ? entry.deprecatedAt.toISOString()
        : null,
      removalDate: entry.removalDate ? entry.removalDate.toISOString() : null,
    });
  }

  /**
   * Resolve the scopes a caller must hold to invoke a tool on a given surface —
   * the single source REST routes use instead of hardcoding a scope string.
   * Returns `undefined` when the tool is not cataloged (caller may fall back to a
   * default). Includes inactive entries so the scope is resolvable even if an
   * admin temporarily disabled the tool.
   */
  async getRequiredScopes(
    identifierOrName: string,
    surface?: ToolSurface
  ): Promise<string[] | undefined> {
    const entry = await this.get(identifierOrName);
    if (!entry) return undefined;
    return requiredScopesForSurface(entry, surface);
  }

  /**
   * Dispatch a `tools/call` for a code-defined tool. Resolves the tool by its
   * wire `name`, checks it is exposed on the given `surface`, checks scope +
   * active state (using that surface's scopes), and invokes the in-process
   * handler.
   *
   * `surface` defaults to `'mcp'` so existing MCP-server callers are unchanged.
   * The agentic Assistant Architect runtime (#926) passes `'internal'` so its
   * tools are validated against the internal surface + its scopes — without this
   * parameter an internal-only tool, or one whose internal scopes differ from
   * its MCP scopes, would be wrongly rejected or scope-checked. (PR review.)
   *
   * Returns a typed {@link ToolDispatchResult} so the caller maps each failure to
   * the correct protocol error code without inspecting message text:
   *   - `reason: 'unknown'` — no active tool exposed on `surface` by that name
   *     (also covers tools on other surfaces, which must not leak across).
   *   - `reason: 'scope_denied'` — found, but the caller lacks the required scope.
   *   - `reason: 'no_handler'` — found and scoped, but no in-process handler (e.g.
   *     an assistant/skill tool dispatched through a different `handlerRef` path).
   */
  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    context: McpToolContext,
    surface: ToolSurface = "mcp",
    callerType?: CatalogCallerType
  ): Promise<ToolDispatchResult> {
    // Version-pinned addressing (#927): a caller may address a specific version
    // as `name@vN` (tools/list `include: "all"` returns multiple versions that
    // share a wire name, so the suffix is the only way to reach a non-latest
    // version). A pinned ref resolves to that exact version; a malformed or
    // removed pin reports as unknown (clear failure for the pinned consumer
    // rather than silently falling back to latest).
    const entry = await this.getForDispatch(toolName);
    // Restrict to tools exposed on the requested surface so cross-surface leakage
    // is impossible: a tool not on `surface` reports as unknown. `getForDispatch`
    // returns inactive entries too, so re-check `isActive` here: a
    // found-but-disabled tool must report as unknown (not leak its existence).
    if (!entry || !entry.isActive || !entry.surfaces.includes(surface)) {
      return { ok: false, reason: "unknown" };
    }
    // Defense-in-depth (#926): the internal agent surface must never invoke a
    // human-only tool, even if a future caller skips the resolver's `agentOnly`
    // list-time filter and dispatches directly.
    if (surface === "internal" && !entry.agentCallable) {
      return { ok: false, reason: "unknown" };
    }
    if (!hasRequiredScopes(context.scopes, requiredScopesForSurface(entry, surface))) {
      return { ok: false, reason: "scope_denied" };
    }
    // Skill-derived tools (#925): `handlerRef: skill:{id}` loads the approved
    // skill's SKILL.md as the tool result (progressive disclosure — a skill is an
    // instruction folder, not a function). Resolved lazily so the S3/DB graph
    // stays out of non-Node bundles, mirroring `loadHandlers`.
    const skillId = parseSkillRef(entry.handlerRef);
    if (skillId) {
      this.maybeEmitDeprecation(entry, surface, callerType, context);
      const { executeSkillTool } = await import(
        "@/lib/skills/skill-tool-executor"
      );
      return { ok: true, result: await executeSkillTool(skillId) };
    }
    // Code MCP tools are keyed in TOOL_HANDLERS by their wire `name` (what the
    // manifest sets and what clients send), resolved lazily to keep the handler
    // graph out of non-Node bundles.
    const handlers = await this.loadHandlers();
    const handler = handlers[entry.name];
    if (!handler) {
      return { ok: false, reason: "no_handler" };
    }
    this.maybeEmitDeprecation(entry, surface, callerType, context);
    return { ok: true, result: await handler(args, context) };
  }

  /**
   * Resolve the catalog entry a dispatch targets. Plain `name` resolves via
   * {@link get} (highest version). `name@vN` resolves to that exact version of
   * the tool whose wire name or identifier matches — or undefined when the pin
   * is malformed or that version does not exist (removed pins must fail clearly,
   * never fall back to latest). (#927.)
   */
  private async getForDispatch(
    toolName: string
  ): Promise<ToolCatalogEntry | undefined> {
    if (!toolName.includes("@")) {
      return this.get(toolName);
    }
    const parsed = parseToolRef(toolName);
    if (!parsed || !parsed.version) return undefined;
    const all = await this.list({ includeInactive: true });
    const matches = all.filter(
      (e) =>
        (e.identifier === parsed.identifier || e.name === parsed.identifier) &&
        e.version === parsed.version
    );
    if (matches.length === 0) return undefined;
    // Prefer identifier matches over wire-name matches (same tiebreak as get()).
    matches.sort((a, b) => {
      const aId = a.identifier === parsed.identifier ? 0 : 1;
      const bId = b.identifier === parsed.identifier ? 0 : 1;
      return aId - bId;
    });
    return matches[0];
  }

  /**
   * Emit the deprecation telemetry event AFTER the dispatch target is confirmed
   * invocable — only tools that will actually run should count as deprecated
   * usage. Fire-and-forget; does not gate or delay dispatch. (#927.)
   */
  private maybeEmitDeprecation(
    entry: ToolCatalogEntry,
    surface: ToolSurface,
    callerType: CatalogCallerType | undefined,
    context: McpToolContext
  ): void {
    if (!entry.deprecatedAt) return;
    this.emitDeprecationWarning(entry, {
      // Default to the surface-implied caller type when not explicitly passed:
      // mcp -> mcp_client, internal -> internal, else fall back to the surface.
      callerType: callerType ?? (surface === "mcp" ? "mcp_client" : "internal"),
      callerId: String(context.userId),
    });
  }
}

/** Process-wide singleton. */
export const toolCatalogInstance = new ToolCatalog();
