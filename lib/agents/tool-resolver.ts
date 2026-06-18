/**
 * Agentic Assistant Runtime — tool resolver (Issue #926).
 *
 * Resolves the AI SDK `ToolSet` for an agentic Assistant Architect run from two
 * sources, intersected with the EXECUTING caller's scopes:
 *
 *   1. Unified tool catalog (#924) — code/assistant/skill tools exposed on the
 *      `internal` surface and marked `agentCallable`. Each becomes an AI SDK tool
 *      whose `execute` dispatches through `toolCatalogInstance.dispatch()` (the
 *      same in-process handler the MCP server uses), so there is no second
 *      implementation to drift.
 *   2. Per-user MCP connectors (Nexus #774) — resolved via `getConnectorTools`,
 *      identical to the Nexus chat path. The caller MUST close these afterward.
 *
 * Security posture (per the catalog scope model + #926 acceptance criteria):
 *   - Author's `enabledToolIdentifiers` is the allow-list; a tool not in it is
 *     never exposed even if the caller could otherwise see it.
 *   - The caller's scopes are intersected on top (scope filtering is all-of), so
 *     a low-privilege executor cannot invoke a tool the author enabled but the
 *     executor lacks the scope for.
 *   - `agentCallable: false` tools are blocked unconditionally (the catalog's
 *     `agentOnly` filter), even if listed by the author.
 *   - Fails CLOSED: an empty resolved set yields zero tools (the model simply has
 *     no tools), never an unfiltered fallback.
 */

import { tool, jsonSchema, type Tool, type ToolSet } from "ai";
import { toolCatalogInstance } from "@/lib/tools/catalog/catalog";
import type { ToolCatalogEntry } from "@/lib/tools/catalog/types";
import type { McpConnectorToolsResult } from "@/lib/mcp/connector-types";
import type { McpToolContext, McpToolResult } from "@/lib/mcp/types";
import { createLogger } from "@/lib/logger";
import type {
  ResolveAgentToolsParams,
  ResolvedAgentTools,
  ToolInvocationAudit,
} from "./types";

/** Cap on a single tool result's serialized size returned to the model loop. */
const MAX_TOOL_RESULT_CHARS = 100_000;
/** Cap on serialized args captured in an audit event (avoids unbounded rows). */
const MAX_AUDIT_ARGS_CHARS = 4_000;

/**
 * Flatten an MCP tool result's content into a model-consumable value. Text items
 * are concatenated; non-text items (image/resource) are summarized so the model
 * gets a stable, serializable payload rather than raw base64 blobs.
 */
function flattenMcpResult(result: McpToolResult): {
  text: string;
  isError: boolean;
} {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push(`[image${item.mimeType ? ` ${item.mimeType}` : ""}]`);
    } else if (item.type === "resource") {
      parts.push(`[resource${item.mimeType ? ` ${item.mimeType}` : ""}]`);
    }
  }
  let text = parts.join("\n");
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]`;
  }
  return { text, isError: result.isError === true };
}

/** Bound the args object captured in an audit event. */
function boundAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(args);
    if (json.length <= MAX_AUDIT_ARGS_CHARS) return args;
    return { __truncated: true, preview: json.slice(0, MAX_AUDIT_ARGS_CHARS) };
  } catch {
    return { __unserializable: true };
  }
}

/**
 * Wrap a single catalog entry as an AI SDK tool. The `execute` dispatches through
 * the catalog (re-checking scope + active state server-side, never trusting the
 * model) and emits an audit event regardless of outcome.
 */
function catalogEntryToTool(
  entry: ToolCatalogEntry,
  ctx: McpToolContext,
  onToolInvocation: ResolveAgentToolsParams["onToolInvocation"],
  log: ReturnType<typeof createLogger>
): Tool {
  return tool({
    description: entry.description,
    // The catalog input schema is already JSON-Schema shaped (MCP inputSchema).
    inputSchema: jsonSchema(entry.inputSchema as Record<string, unknown>),
    execute: async (rawArgs: unknown) => {
      const args =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as Record<string, unknown>)
          : {};
      const startedAt = Date.now();
      let ok = false;
      let error: string | undefined;
      let resultText: string;
      try {
        // Dispatch is resolved by the MCP wire `name` (what handlers are keyed
        // by). The catalog re-validates scope + active state inside dispatch().
        const dispatch = await toolCatalogInstance.dispatch(entry.name, args, ctx);
        if (!dispatch.ok) {
          error = dispatch.reason;
          resultText = `Tool "${entry.name}" could not run (${dispatch.reason}).`;
          log.warn("Agent tool dispatch rejected", {
            tool: entry.identifier,
            reason: dispatch.reason,
          });
        } else {
          const flat = flattenMcpResult(dispatch.result);
          ok = !flat.isError;
          resultText = flat.text;
          if (flat.isError) error = "tool_reported_error";
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        resultText = `Tool "${entry.name}" failed: ${error}`;
        log.error("Agent tool execution threw", {
          tool: entry.identifier,
          error,
        });
      } finally {
        const audit: ToolInvocationAudit = {
          toolIdentifier: entry.identifier,
          toolName: entry.name,
          args: boundAuditArgs(args),
          ok,
          error,
          durationMs: Date.now() - startedAt,
          userId: ctx.userId,
        };
        // Audit must never break the model loop.
        try {
          await onToolInvocation?.(audit);
        } catch (auditErr) {
          log.error("Failed to record tool invocation audit", {
            tool: entry.identifier,
            error:
              auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }
      // Return a plain string result; the AI SDK serializes it into the
      // tool_result block. Errors are returned (not thrown) so the model can
      // recover rather than aborting the whole run.
      return resultText;
    },
  });
}

/**
 * Resolve the merged AI SDK tool set for an agentic run.
 *
 * Catalog tools are resolved on the `internal` surface with the caller's scopes
 * and `agentOnly: true`, then intersected with the author's allow-list. Connector
 * tools are resolved per the caller's connector access (same as Nexus chat).
 */
export async function resolveAgentTools(
  params: ResolveAgentToolsParams
): Promise<ResolvedAgentTools> {
  const { enabledToolIdentifiers, enabledConnectorIds, caller, requestId } =
    params;
  const log = createLogger({ requestId, module: "agent-tool-resolver" });

  const tools: ToolSet = {};
  const grantedToolIdentifiers: string[] = [];
  const deniedToolIdentifiers: string[] = [];

  // ── 1. Catalog (internal-surface) tools ────────────────────────────────────
  const requested = new Set(enabledToolIdentifiers);
  if (requested.size > 0) {
    // The catalog already applies scope + agentCallable + surface filters; what
    // comes back is exactly what THIS caller may invoke on the internal surface.
    const allowedEntries = await toolCatalogInstance.list({
      surface: "internal",
      scopes: caller.scopes,
      agentOnly: true,
    });
    const allowedByIdentifier = new Map(
      allowedEntries.map((e) => [e.identifier, e])
    );

    const ctx: McpToolContext = {
      userId: caller.userId,
      cognitoSub: caller.cognitoSub,
      scopes: caller.scopes,
      requestId,
    };

    for (const identifier of requested) {
      const entry = allowedByIdentifier.get(identifier);
      if (!entry) {
        // Requested by the author but denied to this caller (scope / agentCallable
        // / not internal-surfaced / unknown). Never exposed to the model.
        deniedToolIdentifiers.push(identifier);
        continue;
      }
      tools[entry.name] = catalogEntryToTool(
        entry,
        ctx,
        params.onToolInvocation,
        log
      );
      grantedToolIdentifiers.push(identifier);
    }
  }

  // ── 2. Per-user MCP connector tools ────────────────────────────────────────
  const connectorResults: McpConnectorToolsResult[] = [];
  const failedConnectorIds: string[] = [];
  if (enabledConnectorIds.length > 0) {
    // Lazy-import so the MCP client graph (@ai-sdk/mcp -> pkce-challenge, ESM)
    // is only pulled in when connectors are actually used — keeps it out of any
    // non-Node bundle and out of the resolver's test import graph.
    const { getConnectorTools } = await import("@/lib/mcp/connector-service");
    const connectorOptions = caller.idToken
      ? { idToken: caller.idToken }
      : undefined;
    const settled = await Promise.allSettled(
      enabledConnectorIds.map((serverId) =>
        getConnectorTools(
          serverId,
          caller.userId,
          caller.roleNames,
          connectorOptions
        )
      )
    );
    for (const [i, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        connectorResults.push(result.value);
        Object.assign(tools, result.value.tools);
      } else {
        failedConnectorIds.push(enabledConnectorIds[i]);
        log.warn("Failed to resolve agent connector tools", {
          serverId: enabledConnectorIds[i],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
  }

  log.info("Resolved agent tools", {
    catalogRequested: requested.size,
    catalogGranted: grantedToolIdentifiers.length,
    catalogDenied: deniedToolIdentifiers.length,
    connectorsRequested: enabledConnectorIds.length,
    connectorsResolved: connectorResults.length,
    connectorsFailed: failedConnectorIds.length,
    totalTools: Object.keys(tools).length,
  });

  return {
    tools,
    grantedToolIdentifiers,
    deniedToolIdentifiers,
    connectorResults,
    failedConnectorIds,
  };
}

/**
 * Close all open MCP connector clients for a run. Mirrors the Nexus chat
 * `closeMcpClients` pattern: call from onFinish/onError (NOT a synchronous
 * finally), so clients stay open while tool calls are still in flight.
 */
export async function closeAgentConnectorClients(
  connectorResults: McpConnectorToolsResult[],
  requestId: string
): Promise<void> {
  if (connectorResults.length === 0) return;
  const log = createLogger({ requestId, module: "agent-tool-resolver" });
  const settled = await Promise.allSettled(
    connectorResults.map((r) => r.close())
  );
  const failed = settled.filter((s) => s.status === "rejected").length;
  if (failed > 0) {
    log.warn("Some agent connector clients failed to close", {
      failed,
      total: connectorResults.length,
    });
  }
}
