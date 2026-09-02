"use server";

/**
 * Viewer-scoped PSD data queries for sandboxed Atrium artifacts (#1705).
 *
 * The third — and read-ONLY — operation on the `AtriumData` sandbox bridge.
 * Where `submitArtifactRecord` / `listArtifactRecords` persist artifact-defined
 * rows, this action forwards a page-supplied SQL string to the PSD Data MCP
 * server **as the person viewing the artifact**, so that server's row-level
 * security is evaluated against the VIEWER rather than the author. The page
 * never sees, holds, or influences the viewer's Cognito ID token: the token is
 * read from the server session here and handed straight to
 * `getConnectorTools(..., { idToken })`, which is the same `cognito_passthrough`
 * chain Nexus chat and Assistant Architect already use for this server
 * (migration 060, #803).
 *
 * ## What the page may influence
 * EXACTLY three fields: `sql_query`, `limit`, `offset`. Everything else is
 * forced server-side — the tool name (`query_data` and nothing else), `format:
 * "json"`, `export: false`, `view_results: true`, and the audit `reason`, which
 * always names the artifact and version so the data MCP's audit log reads as
 * "this viewer, via artifact X" rather than "this viewer typed a query". A
 * request that carries `export`, `format`, `reason`, or a tool name is not
 * rejected for it; those fields simply never reach here, because the bridge
 * copies only the three allowed fields and this action re-derives the rest.
 *
 * ## Why no per-artifact review is needed
 * The security argument rests on ONE invariant: a data-connected artifact has no
 * egress. Network is closed by the sandbox CSP (`connect-src 'none'`, `img-src`
 * without an https wildcard, `form-action 'none'`, `base-uri 'none'`, and
 * `sandbox="allow-scripts"` with no navigation or popups); the data MCP's write
 * tools and CSV export links are closed by the tool allowlist below; and the one
 * remaining channel — writing rows into `content_data_records` and reading them
 * back as the author — is closed by `data_access` being mutually exclusive
 * (`queryArtifactData` requires `query`; the record actions require `records`).
 * With every path closed, a data-connected artifact is a pure function from
 * "what this viewer may see" to pixels on this viewer's screen, whatever the
 * author intended. Evaluate any FUTURE bridge operation against that invariant
 * before shipping it.
 *
 * Failures collapse to a generic message on the way out: upstream MCP/database
 * text never reaches the frame.
 */

import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, ErrorFactories, handleError } from "@/lib/error-utils";
import { getServerSession } from "@/lib/auth/server-session";
import type { CognitoSession } from "@/lib/auth/server-session";
import { contentService } from "@/lib/content";
import { getConnectorTools } from "@/lib/mcp/connector-service";
import { getNexusRouterConfig } from "@/lib/nexus/model-router/config";
import { resolvePsdDataConnectorId } from "@/lib/nexus/model-router/psd-data-connector";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { ActionState } from "@/types";
import { getUserRequester } from "./requester";

/** The ONLY tool this action may invoke on the data connector. */
const QUERY_TOOL_NAME = "query_data";
const MAX_CONTENT_ID_LENGTH = 200;
/**
 * Upper bound on the page-supplied SQL. Generous enough for a real aggregate
 * with CTEs, small enough that a hostile page cannot use the action transport
 * as an allocation amplifier. The data MCP applies its own parser limits.
 */
const MAX_SQL_LENGTH = 8_000;
const DEFAULT_QUERY_LIMIT = 200;
/**
 * Mirrors the data MCP's `JSON_ROW_LIMIT` (2000). Capping here too means an
 * out-of-range page value is clamped rather than round-tripped for a rejection.
 */
const MAX_QUERY_LIMIT = 2_000;
const MAX_QUERY_OFFSET = 1_000_000;
/**
 * Each query is Lambda + RDS behind an MCP round trip. Chat's connector path
 * already budgets 30s, so the bridge uses the same ceiling rather than the
 * records bridge's 10s (which would time out legitimate aggregates).
 */
const QUERY_TIMEOUT_MS = 30_000;
/**
 * Dashboards fire several queries per load — more often than chat — so the
 * budget is per viewer PER ARTIFACT rather than per viewer. The data MCP's own
 * per-user limit remains the backstop.
 */
const QUERY_RATE_LIMIT = 60;
const QUERY_RATE_WINDOW_MS = 60 * 1000;
const QUERY_RATE_NAMESPACE = "atrium-artifact-data-query";

export interface QueryArtifactDataInput {
  contentId: string;
  /** Page-supplied SQL. Executed by the data MCP under the VIEWER's RLS. */
  sql: string;
  limit?: number;
  offset?: number;
}

/** The data MCP's `format: "json"` body, camelCased for the bridge. */
export interface QueryArtifactDataResult {
  columns: string[];
  /** Row tuples in `columns` order (duplicate column names cannot collide). */
  rows: unknown[][];
  totalCount: number;
  returnedCount: number;
  limit: number;
  offset: number;
  truncated: boolean;
}

/** The JSON body shape the data MCP returns in `format: "json"` mode. */
interface DataMcpJsonBody {
  columns?: unknown;
  rows?: unknown;
  total_count?: unknown;
  returned_count?: unknown;
  limit?: unknown;
  offset?: unknown;
  truncated?: unknown;
}

function validateContentId(contentId: unknown): string {
  if (typeof contentId !== "string") {
    throw ErrorFactories.missingRequiredField("contentId");
  }
  // Bound attacker-controlled work before trim allocates a normalized copy.
  if (contentId.length > MAX_CONTENT_ID_LENGTH) {
    throw ErrorFactories.valueOutOfRange(
      "contentId",
      contentId.length,
      1,
      MAX_CONTENT_ID_LENGTH
    );
  }
  const normalized = contentId.trim();
  if (!normalized) throw ErrorFactories.missingRequiredField("contentId");
  return normalized;
}

function validateSql(sql: unknown): string {
  if (typeof sql !== "string") {
    throw ErrorFactories.missingRequiredField("sql");
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw ErrorFactories.valueOutOfRange("sql", sql.length, 1, MAX_SQL_LENGTH);
  }
  const trimmed = sql.trim();
  if (!trimmed) throw ErrorFactories.missingRequiredField("sql");
  // Deliberately NOT parsed or allowlisted here. The data MCP owns SQL policy
  // (it rewrites for row-level security and audits every statement); a second,
  // weaker parser in this layer would create a false sense of enforcement and
  // reject legitimate queries the server accepts.
  return trimmed;
}

/** Integer-bound a page-supplied count, clamping rather than round-tripping. */
function normalizeBoundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw ErrorFactories.valueOutOfRange(
      field,
      typeof value === "number" ? value : 0,
      0,
      max
    );
  }
  return Math.min(Math.floor(value), max);
}

/** The three page-supplied fields, validated and bounded. */
interface ValidatedQueryParams {
  sql: string;
  limit: number;
  offset: number;
}

function validateQueryParams(input: QueryArtifactDataInput): ValidatedQueryParams {
  return {
    sql: validateSql(input?.sql),
    limit: normalizeBoundedInteger(
      input?.limit,
      "limit",
      DEFAULT_QUERY_LIMIT,
      MAX_QUERY_LIMIT
    ),
    offset: normalizeBoundedInteger(
      input?.offset,
      "offset",
      0,
      MAX_QUERY_OFFSET
    ),
  };
}

/**
 * Session + budget gate, run BEFORE any database work so an over-budget or
 * unauthenticated page cannot amplify into requester/visibility lookups.
 * Returns the live session; throws otherwise.
 */
async function authorizeQueryRequest(contentId: string): Promise<{
  /** The SAME session object the requester is built from — resolved once. */
  session: CognitoSession;
  idToken: string;
}> {
  const session = await getServerSession();
  if (!session?.sub) throw ErrorFactories.authNoSession();
  // Fail closed without a passthrough token: there is no author-scoped
  // fallback, by design. The page renders a "reload to refresh your session"
  // state instead of quietly seeing someone else's permissions.
  if (!session.idToken) throw ErrorFactories.authNoSession();

  // Per viewer PER ARTIFACT — dashboards fire several queries per load.
  const rateLimit = consumeRateLimit({
    interval: QUERY_RATE_WINDOW_MS,
    uniqueTokenPerInterval: QUERY_RATE_LIMIT,
    namespace: QUERY_RATE_NAMESPACE,
    identifier: `user-sub:${session.sub}:content:${contentId}`,
  });
  if (!rateLimit.allowed) {
    throw ErrorFactories.bizRateLimitExceeded(
      "query artifact data",
      rateLimit.retryAfterSeconds,
      new Date(rateLimit.resetTime).toISOString()
    );
  }
  return { session, idToken: session.idToken };
}

function assertQueryMode(content: { kind: string; dataAccess: string }): void {
  if (content.kind !== "artifact") {
    throw ErrorFactories.validationFailed([
      { field: "contentId", message: "Content is not an artifact" },
    ]);
  }
  // The exclusivity gate. `records` and `none` artifacts never reach the data
  // MCP; see the file header for why the modes can never be combined.
  if (content.dataAccess !== "query") {
    throw ErrorFactories.validationFailed([
      {
        field: "contentId",
        message: "Artifact is not configured for data queries",
      },
    ]);
  }
}

/** Resolve "the PSD data server", failing closed when it is not configured. */
async function requirePsdDataConnectorId(): Promise<string> {
  const { config } = await getNexusRouterConfig();
  const connectorId = await resolvePsdDataConnectorId(config);
  if (!connectorId) {
    throw ErrorFactories.sysConfigurationError(
      "The PSD data connector is not configured",
      { setting: "specialists.psdDataConnectorId" }
    );
  }
  return connectorId;
}

function dataMcpFailure(detail: string): Error {
  return ErrorFactories.externalServiceError("psd-data-mcp", new Error(detail));
}

/**
 * Pull the JSON body out of an MCP `CallToolResult`. The data MCP returns one
 * text content block holding the JSON object; anything else (an error result, a
 * non-text block, unparseable text) is a failure, never a partial result.
 */
function parseToolResult(result: unknown): QueryArtifactDataResult {
  if (typeof result !== "object" || result === null) {
    throw dataMcpFailure("empty tool result");
  }
  const envelope = result as { isError?: unknown; content?: unknown };
  if (envelope.isError === true) {
    throw dataMcpFailure("tool reported an error");
  }
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
  );
  if (!textBlock) throw dataMcpFailure("no text content");

  let body: DataMcpJsonBody;
  try {
    body = JSON.parse(textBlock.text) as DataMcpJsonBody;
  } catch {
    throw dataMcpFailure("unparseable json body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw dataMcpFailure("json body is not an object");
  }
  if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
    throw dataMcpFailure("json body missing columns/rows");
  }

  const columns = body.columns.map((column) => String(column));
  const rows = body.rows.map((row) => (Array.isArray(row) ? row : [row]));
  const toCount = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  return {
    columns,
    rows,
    totalCount: toCount(body.total_count, rows.length),
    returnedCount: toCount(body.returned_count, rows.length),
    limit: toCount(body.limit, rows.length),
    offset: toCount(body.offset, 0),
    truncated: body.truncated === true,
  };
}

/**
 * Invoke `query_data` on the resolved connector with the forced arguments and a
 * hard timeout, always closing the MCP client.
 */
async function callQueryData(args: {
  connectorId: string;
  userId: number;
  roles: string[];
  idToken: string;
  sql: string;
  limit: number;
  offset: number;
  reason: string;
}): Promise<QueryArtifactDataResult> {
  const connector = await getConnectorTools(
    args.connectorId,
    args.userId,
    args.roles,
    { idToken: args.idToken }
  );
  try {
    const tool = connector.tools[QUERY_TOOL_NAME];
    const execute = tool?.execute;
    if (typeof execute !== "function") {
      throw dataMcpFailure(`connector does not expose ${QUERY_TOOL_NAME}`);
    }
    const result = await execute(
      {
        // Page-supplied — the ONLY three fields that cross the sandbox boundary.
        sql_query: args.sql,
        limit: args.limit,
        offset: args.offset,
        // Forced server-side. `export: false` keeps CSV download links out of
        // reach; `format: "json"` is what makes the response machine-usable.
        format: "json",
        export: false,
        view_results: true,
        reason: args.reason,
      },
      {
        toolCallId: `atrium-artifact-query-${Date.now()}`,
        messages: [],
        abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      }
    );
    return parseToolResult(result);
  } finally {
    await connector.close().catch(() => {});
  }
}

export async function queryArtifactData(
  input: QueryArtifactDataInput
): Promise<ActionState<QueryArtifactDataResult>> {
  const requestId = generateRequestId();
  const timer = startTimer("queryArtifactData");
  const log = createLogger({ requestId, action: "queryArtifactData" });

  try {
    const contentId = validateContentId(input?.contentId);
    const { session, idToken } = await authorizeQueryRequest(contentId);
    const params = validateQueryParams(input);

    // Same session instance the gate above validated — never a second resolve.
    const requester = await getUserRequester(requestId, session);
    // Keep the boundary fail-closed if requester resolution ever broadens.
    if (requester.kind !== "user" || requester.userId == null) {
      throw ErrorFactories.authNoSession();
    }

    log.info("Action started: query artifact data", {
      contentId: sanitizeForLogging(contentId),
      sqlLength: params.sql.length,
      limit: params.limit,
      offset: params.offset,
    });

    // Shared 404 mask for missing/non-viewable content, exactly as the record
    // actions do — a viewer who cannot see the artifact learns nothing.
    const content = await contentService.get(requester, contentId);
    assertQueryMode(content);

    // `getConnectorTools` runs `requireUserAccess` internally (allow list, else
    // staff/administrator), so a student or an out-of-list viewer is refused
    // BEFORE any request reaches the data MCP.
    const result = await callQueryData({
      connectorId: await requirePsdDataConnectorId(),
      userId: requester.userId,
      roles: requester.roles ?? [],
      idToken,
      sql: params.sql,
      limit: params.limit,
      offset: params.offset,
      // The audit line the data MCP records for this call.
      reason: `atrium artifact ${content.id} v${content.currentVersionId ?? "none"}`,
    });

    timer({ status: "success" });
    log.info("Artifact data query completed", {
      contentId: content.id,
      userId: requester.userId,
      returnedCount: result.returnedCount,
      truncated: result.truncated,
    });
    return createSuccess(result, "Artifact data query completed");
  } catch (error) {
    timer({ status: "error" });
    // The bridge collapses every failure to one generic string before it reaches
    // the frame; this handler keeps the detail server-side for operators.
    return handleError(error, "Failed to query artifact data", {
      context: "queryArtifactData",
      requestId,
      operation: "queryArtifactData",
    });
  }
}
