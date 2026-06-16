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
 * Scope filtering generalizes the MCP `getToolsForScopes()` pattern to all
 * surfaces: a caller sees a tool only if it holds every `requiredScope` (or the
 * `*` wildcard). `agentOnly` additionally drops `agentCallable = false` tools so
 * internal agent loops cannot invoke human-only / destructive tools.
 */

import { ne } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { toolCatalog } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import type { McpToolHandler, McpToolResult, McpToolContext } from "@/lib/mcp/types";
import { TOOL_MANIFEST } from "@/lib/tools/catalog/manifest";
import type {
  ToolCatalogEntry,
  ToolCatalogFilter,
  ToolManifestEntry,
} from "@/lib/tools/catalog/types";

const log = createLogger({ module: "tool-catalog" });

/** DB cache TTL — matches settings-manager's 5-minute cache. */
const DB_CACHE_TTL_MS = 5 * 60 * 1000;

interface DbCache {
  entries: ToolCatalogEntry[];
  expiresAt: number;
}

/** In-process handler map for code-defined tools, keyed by identifier. */
function buildHandlerMap(): Map<string, McpToolHandler> {
  const map = new Map<string, McpToolHandler>();
  for (const entry of TOOL_MANIFEST) {
    if (entry.handler) {
      map.set(entry.identifier, entry.handler);
    }
  }
  return map;
}

/** Project a manifest entry into a runtime catalog entry. */
function manifestToEntry(entry: ToolManifestEntry): ToolCatalogEntry {
  return {
    identifier: entry.identifier,
    version: entry.version ?? "v1",
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    surfaces: entry.surfaces,
    requiredScopes: entry.requiredScopes,
    agentCallable: entry.agentCallable ?? true,
    source: "code",
    isActive: true,
    handlerRef: entry.identifier,
  };
}

/** True when `scopes` grant access to a tool requiring `requiredScopes`. */
function hasRequiredScopes(scopes: string[], requiredScopes: string[]): boolean {
  if (scopes.includes("*")) return true;
  // A tool with no required scopes is open to any authenticated caller.
  if (requiredScopes.length === 0) return true;
  return requiredScopes.every((s) => scopes.includes(s));
}

/**
 * The unified tool catalog. A module-level singleton (`toolCatalogInstance`)
 * holds the DB cache; the manifest is read fresh from the imported constant.
 */
export class ToolCatalog {
  private dbCache: DbCache | null = null;
  private readonly handlers: Map<string, McpToolHandler> = buildHandlerMap();

  /** Manifest-derived runtime entries (no DB round-trip). */
  private manifestEntries(): ToolCatalogEntry[] {
    return TOOL_MANIFEST.map(manifestToEntry);
  }

  /** Load non-code DB entries (assistant/skill), cached with a short TTL. */
  private async dbEntries(): Promise<ToolCatalogEntry[]> {
    const now = Date.now();
    if (this.dbCache && this.dbCache.expiresAt > now) {
      return this.dbCache.entries;
    }

    try {
      const rows = await executeQuery(
        (db) =>
          db
            .select()
            .from(toolCatalog)
            // Code rows are authoritative from the manifest; only merge the
            // dynamic (assistant/skill) rows from the DB to avoid double-listing.
            .where(ne(toolCatalog.source, "code")),
        "toolCatalog.loadDbEntries"
      );

      const entries: ToolCatalogEntry[] = rows.map((r) => ({
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
        agentCallable: r.agentCallable,
        source: r.source,
        isActive: r.isActive,
        handlerRef: r.handlerRef ?? undefined,
      }));

      this.dbCache = { entries, expiresAt: now + DB_CACHE_TTL_MS };
      return entries;
    } catch (error) {
      // On DB failure, degrade gracefully to manifest-only rather than throwing
      // and breaking every chat/MCP request. Log so the failure is observable.
      log.error("Failed to load DB tool catalog entries; using manifest only", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Invalidate the DB cache (call after assistant/skill catalog writes). */
  invalidate(): void {
    this.dbCache = null;
  }

  /**
   * List catalog tools, optionally filtered by scopes, surface, and
   * agent-callability. Active-only by default. Manifest (code) entries win on an
   * identifier@version collision with a DB row.
   */
  async list(filter: ToolCatalogFilter = {}): Promise<ToolCatalogEntry[]> {
    const merged = new Map<string, ToolCatalogEntry>();
    for (const e of await this.dbEntries()) {
      merged.set(`${e.identifier}@${e.version}`, e);
    }
    // Manifest entries override DB rows for the same key (code is authoritative).
    for (const e of this.manifestEntries()) {
      merged.set(`${e.identifier}@${e.version}`, e);
    }

    let entries = [...merged.values()];

    if (!filter.includeInactive) {
      entries = entries.filter((e) => e.isActive);
    }
    if (filter.surface) {
      entries = entries.filter((e) => e.surfaces.includes(filter.surface!));
    }
    if (filter.scopes) {
      entries = entries.filter((e) =>
        hasRequiredScopes(filter.scopes!, e.requiredScopes)
      );
    }
    if (filter.agentOnly) {
      entries = entries.filter((e) => e.agentCallable);
    }

    return entries;
  }

  /** Resolve a single tool by identifier (latest matching version) or by name. */
  async get(identifierOrName: string): Promise<ToolCatalogEntry | undefined> {
    const all = await this.list({ includeInactive: true });
    return (
      all.find((e) => e.identifier === identifierOrName) ??
      all.find((e) => e.name === identifierOrName)
    );
  }

  /**
   * Dispatch an MCP `tools/call` for a code-defined tool. Resolves the tool by
   * its MCP wire `name` (what clients send), checks scope + active state, and
   * invokes the in-process handler.
   *
   * Returns `null` when the tool is unknown or has no in-process handler (the
   * caller decides how to surface that — e.g. assistant/skill tools dispatch
   * through a different path keyed on `handlerRef`).
   */
  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    context: McpToolContext
  ): Promise<McpToolResult | null> {
    const entry = await this.get(toolName);
    if (!entry || !entry.isActive) {
      return null;
    }
    if (!hasRequiredScopes(context.scopes, entry.requiredScopes)) {
      return {
        content: [
          { type: "text", text: `Insufficient scope for tool: ${toolName}` },
        ],
        isError: true,
      };
    }
    const handler = this.handlers.get(entry.identifier);
    if (!handler) {
      return null;
    }
    return handler(args, context);
  }
}

/** Process-wide singleton. */
export const toolCatalog_instance = new ToolCatalog();
