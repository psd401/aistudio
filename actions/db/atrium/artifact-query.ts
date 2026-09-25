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
 * ## How failures are reported (#1787)
 * Every failure is classified into one `ArtifactBridgeErrorCode` (see
 * `lib/content/artifact-bridge-errors.ts`) so the page can tell "you are signed
 * out" from "your SQL names a column that does not exist" — they used to be the
 * same string, which is how a broken dashboard could look like a permissions
 * problem to the viewer, the author, and the model that wrote it.
 *
 * Upstream MCP/database TEXT is still withheld from plain readers. It is attached
 * (as `detail`) only when the requester may EDIT the artifact: an editor can open
 * the Code tab, read that SQL, and run it themselves, so the Postgres message
 * about their own statement tells them nothing they could not already obtain.
 * The full upstream text is ALWAYS logged server-side, for either audience.
 */

import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { ErrorFactories, handleError } from "@/lib/error-utils";
import { getServerSession } from "@/lib/auth/server-session";
import type { CognitoSession } from "@/lib/auth/server-session";
import { contentService } from "@/lib/content";
import type { ContentDataAccess } from "@/lib/content/types";
import { canEdit } from "@/lib/content/helpers";
import {
  artifactBridgeErrorMessage,
  boundBridgeErrorMessage,
  type ArtifactBridgeErrorCode,
} from "@/lib/content/artifact-bridge-errors";
import { getConnectorTools } from "@/lib/mcp/connector-service";
import { getNexusRouterConfig } from "@/lib/nexus/model-router/config";
import { resolvePsdDataConnectorId } from "@/lib/nexus/model-router/psd-data-connector";
import { consumeRateLimit } from "@/lib/rate-limit";
import { ErrorCode } from "@/types/error-types";
import {
  assertArtifactDataAccess,
  resolveRenderedVersionAccess,
  validateContentId,
} from "./artifact-guards";
import { getUserRequester } from "./requester";

/** The ONLY tool this action may invoke on the data connector. */
const QUERY_TOOL_NAME = "query_data";
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
 * ONE overall budget for the connector handshake AND the query (#1788).
 *
 * Each query is Lambda + RDS behind an MCP round trip. Chat's connector path
 * already budgets 30s, so the bridge uses the same ceiling rather than the
 * records bridge's 10s (which would time out legitimate aggregates).
 *
 * This clock used to start only at `execute()`, which meant the real server-side
 * worst case was the handshake (`MCP_CLIENT_TIMEOUT_MS` for the client, plus
 * tools/list) PLUS 30s — comfortably past the sandbox host's 45s, so a slow
 * handshake made the host give up on a query that was still running and the
 * page retried it.
 *
 * It is now armed at the TOP of `queryArtifactData` and threaded down, so it
 * spans the preflight (session resolution, the `contentService.get` visibility
 * check, the version lookup, the connector config read), the handshake, AND the
 * execution. Covering only part of the server's work left the same hole in a
 * smaller form: a 15s preflight plus a full 30s execution still exceeds the
 * host's 45s. The server now always loses that race BY CONSTRUCTION rather than
 * by assuming any stage is fast.
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
  /**
   * The version whose code is actually RUNNING in the frame (#1787), supplied by
   * the bridge from its own trusted props — never from the artifact's message.
   * It exists only to make the data MCP's audit line say which version asked:
   * `content.currentVersionId` is the working HEAD, which is the wrong answer on
   * a `/c/` published page or whenever the canvas dropdown previews an older
   * version. Validated as belonging to this object before it is used.
   */
  versionId?: string;
}

/**
 * The failure shape `queryArtifactData` returns (#1787). A strict narrowing of
 * `ActionState`'s failure arm — extra fields only — so existing callers that
 * treat it as `ActionState` keep working.
 */
export interface QueryArtifactDataFailure {
  isSuccess: false;
  message: string;
  /** The typed reason, carried through the bridge to `err.code` in the frame. */
  code: ArtifactBridgeErrorCode;
  /** Present for `rate_limited` only. */
  retryAfterSeconds?: number;
  /**
   * Upstream text (e.g. `column "school_name" does not exist`). Present only for
   * `query_error`, and only when the requester may EDIT this artifact.
   */
  detail?: string;
}

export type QueryArtifactDataOutcome =
  | { isSuccess: true; message: string; data: QueryArtifactDataResult }
  | QueryArtifactDataFailure;

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

/** Resolve "the PSD data server", failing closed when it is not configured. */
async function requirePsdDataConnectorId(
  /**
   * Called between this helper's OWN two async stages (#1788). The caller
   * checks its deadline before entering, but the config read and the connector
   * lookup are two sequential awaits: a config read that starts inside the
   * budget and finishes outside it would otherwise go on to start a fresh
   * database query for a caller that has already been answered `timeout`.
   */
  stopIfExpired: () => void = () => {}
): Promise<string> {
  const { config } = await getNexusRouterConfig();
  stopIfExpired();
  const connectorId = await resolvePsdDataConnectorId(config);
  if (!connectorId) {
    throw ErrorFactories.sysConfigurationError(
      "The PSD data connector is not configured",
      { setting: "specialists.psdDataConnectorId" }
    );
  }
  return connectorId;
}

/**
 * An error carrying the bridge code the classifier should use, for the cases the
 * generic `ErrorCode` taxonomy cannot distinguish: a mode mismatch and a data-MCP
 * tool error are both `VALIDATION_FAILED`/`EXTERNAL_SERVICE_ERROR` to
 * `ErrorFactories`, but `not_query_mode` and `query_error` are the whole point of
 * #1787. `bridgeDetail` is the upstream text — always logged, and forwarded to
 * the page only for an editor.
 */
interface BridgeTaggedError extends Error {
  bridgeCode?: ArtifactBridgeErrorCode;
  bridgeDetail?: string;
}

function tagBridgeError<T extends Error>(
  error: T,
  code: ArtifactBridgeErrorCode,
  detail?: string
): T {
  const tagged = error as T & BridgeTaggedError;
  tagged.bridgeCode = code;
  if (detail !== undefined) tagged.bridgeDetail = detail;
  return tagged;
}

/**
 * A malformed/unusable answer from the data MCP — the request reached it, but
 * what came back is not a result. Not the artifact's SQL problem, so it stays
 * `unavailable`; `dataMcpQueryError` is the SQL one.
 */
function dataMcpFailure(detail: string): Error {
  return tagBridgeError(
    ErrorFactories.externalServiceError("psd-data-mcp", new Error(detail)),
    "unavailable"
  );
}

/**
 * The data MCP ran the statement and reported an error (`isError: true`) — bad
 * SQL, an unknown column, a table the viewer's row-level policy refuses. `text`
 * is the server's own message, which is ABOUT THE ARTIFACT'S OWN SQL.
 */
function dataMcpQueryError(text: string | null): Error {
  return tagBridgeError(
    ErrorFactories.externalServiceError(
      "psd-data-mcp",
      new Error(text ?? "tool reported an error")
    ),
    "query_error",
    text ?? undefined
  );
}

/**
 * Pull whatever human-readable text an MCP `CallToolResult` carries, joining the
 * text blocks. Returns null when there is none to report.
 */
function textFromToolContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return boundBridgeErrorMessage(parts.join(" "));
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
    // #1787: keep the server's own text. Discarding it here was why a Postgres
    // `column "x" does not exist` never reached the author OR the server logs.
    throw dataMcpQueryError(textFromToolContent(envelope.content));
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

  // Column names must already be strings. Coercing with String() would turn a
  // contract violation upstream (an object, a null) into a plausible-looking
  // "[object Object]" header instead of failing closed, which is the opposite
  // of the never-a-partial-result rule the rest of this parser follows.
  const columns = body.columns.map((column) => {
    if (typeof column !== "string") {
      throw dataMcpFailure("column name is not a string");
    }
    return column;
  });
  // Every row must be a tuple in `columns` order. A row-object or a ragged row
  // would otherwise reach the page as a "successful" result with every cell
  // after the first reading `undefined` -- silent corruption, not a failure.
  const rows = body.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw dataMcpFailure("row/column shape mismatch");
    }
    return row;
  });
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
 * `requireUserAccess` (inside `getConnectorTools`) refuses a viewer who is
 * neither on the server's allow list nor staff/administrator, and it throws a
 * PLAIN `Error` with no code — so the message is the only signal that this is a
 * permission refusal rather than "the MCP server is down". Matched narrowly, and
 * only to choose between `forbidden` and `unavailable`: both refuse the request.
 */
const CONNECTOR_ACCESS_DENIED_RE =
  /does not have (?:role-based )?access to MCP server/i;

/** Validation codes: the page asked for something malformed. */
const REQUEST_VALIDATION_CODES: ReadonlySet<string> = new Set([
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.INVALID_INPUT,
  ErrorCode.MISSING_REQUIRED_FIELD,
  ErrorCode.INVALID_FORMAT,
  ErrorCode.VALUE_OUT_OF_RANGE,
  "CONTENT_VALIDATION",
]);

/** Map a typed/domain error `code` onto the bridge's closed code set. */
function bridgeCodeForErrorCode(code: string): ArtifactBridgeErrorCode {
  if (code === ErrorCode.BIZ_RATE_LIMIT_EXCEEDED) return "rate_limited";
  if (code === ErrorCode.EXTERNAL_SERVICE_TIMEOUT || code === ErrorCode.DB_TIMEOUT) {
    return "timeout";
  }
  // The shared 404 mask: "cannot see it" and "does not exist" are deliberately
  // the same answer, and `forbidden` is the honest one for a viewer.
  if (
    code === ErrorCode.DB_RECORD_NOT_FOUND ||
    code === "CONTENT_NOT_FOUND" ||
    code === "CONTENT_FORBIDDEN"
  ) {
    return "forbidden";
  }
  if (code.startsWith("AUTHZ_")) return "forbidden";
  if (code.startsWith("AUTH_")) return "unauthenticated";
  if (REQUEST_VALIDATION_CODES.has(code)) return "query_error";
  return "unavailable";
}

/** One classified failure, before the editor gate decides what the page sees. */
interface ClassifiedQueryFailure {
  code: ArtifactBridgeErrorCode;
  retryAfterSeconds?: number;
  /** Upstream/technical text. ALWAYS logged; forwarded only for an editor. */
  detail?: string;
  /**
   * `detail` describes the page's OWN request (text this server wrote, never
   * upstream text), so it is forwarded to every viewer, not just an editor.
   */
  detailIsViewerSafe?: boolean;
}

/**
 * Classify a thrown failure into exactly one bridge code (#1787). Errors we
 * construct carry the answer already (`bridgeCode`); everything else is mapped
 * from its `ErrorCode`, its `name` (abort/timeout), or the connector's
 * access-refusal message.
 */
function classifyQueryFailure(error: unknown): ClassifiedQueryFailure {
  if (!(error instanceof Error)) return { code: "unavailable" };
  const tagged = error as BridgeTaggedError;
  if (tagged.bridgeCode) {
    return {
      code: tagged.bridgeCode,
      ...(tagged.bridgeDetail ? { detail: tagged.bridgeDetail } : {}),
    };
  }
  // `AbortSignal.timeout` rejects with a DOMException named TimeoutError; an
  // MCP client that forwards the signal may surface AbortError instead.
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return { code: "timeout" };
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    const bridgeCode = bridgeCodeForErrorCode(code);
    if (bridgeCode === "rate_limited") {
      const retryAfterSeconds = (
        error as { rateLimit?: { retryAfterSeconds?: unknown } }
      ).rateLimit?.retryAfterSeconds;
      return {
        code: "rate_limited",
        ...(typeof retryAfterSeconds === "number" && retryAfterSeconds >= 0
          ? { retryAfterSeconds }
          : {}),
      };
    }
    // A validation refusal is about the page's OWN request (a missing sql, an
    // out-of-range limit), so its message is safe for any viewer to read.
    if (bridgeCode === "query_error") {
      const detail = boundBridgeErrorMessage(error.message);
      return {
        code: bridgeCode,
        ...(detail ? { detail, detailIsViewerSafe: true } : {}),
      };
    }
    return { code: bridgeCode };
  }
  if (CONNECTOR_ACCESS_DENIED_RE.test(error.message)) return { code: "forbidden" };
  return { code: "unavailable" };
}

/**
 * Invoke `query_data` on the resolved connector with the forced arguments and a
 * hard timeout, always closing the MCP client.
 */
/**
 * Reject as soon as `signal` aborts, even when `work` never settles (#1788).
 *
 * `getConnectorTools` takes no AbortSignal, so the handshake could otherwise run
 * past the whole budget. A connector that arrives AFTER the deadline is closed
 * rather than leaked — the caller has already given up on it.
 */
function withDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onLateSettle: (value: T) => void
): Promise<T> {
  if (signal.aborted) {
    void work.then(onLateSettle, () => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          onLateSettle(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      }
    );
  });
}

async function callQueryData(args: {
  /**
   * The caller's end-to-end budget, already running (#1788). It covers the
   * PREFLIGHT as well as the handshake and the execution, so the three cannot
   * add up to more than the sandbox host's own clock allows. Armed by
   * `queryArtifactData` rather than here, because the preflight it must cover
   * happens before this function is reached.
   *
   * `AbortSignal.timeout` aborts with a DOMException named TimeoutError, which
   * `classifyQueryFailure` already maps to the `timeout` bridge code.
   */
  deadline: AbortSignal;
  connectorId: string;
  userId: number;
  roles: string[];
  idToken: string;
  sql: string;
  limit: number;
  offset: number;
  reason: string;
}): Promise<QueryArtifactDataResult> {
  const { deadline } = args;
  // Already out of budget before any connector work: fail here rather than
  // opening an MCP client we have given up on. `withDeadline` would handle a
  // pre-aborted signal safely (it closes a connector that arrives late), but
  // the handshake would still have been STARTED -- a Lambda invocation and a
  // tools/list round trip for an answer nobody can receive.
  if (deadline.aborted) throw deadline.reason;
  const connector = await withDeadline(
    getConnectorTools(args.connectorId, args.userId, args.roles, {
      idToken: args.idToken,
    }),
    deadline,
    (late) => {
      void late.close().catch(() => {});
    }
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
        // The SAME signal the handshake raced: what is left of the 30s budget,
        // never a fresh one (#1788).
        abortSignal: deadline,
      }
    );
    return parseToolResult(result);
  } finally {
    await connector.close().catch(() => {});
  }
}

/**
 * The exclusivity gate, retagged (#1787). `assertArtifactDataAccess` raises a
 * generic `VALIDATION_FAILED`, which is indistinguishable from "your `limit` is
 * out of range" — and telling a records-mode artifact that its SQL is broken is
 * exactly the confusion this issue is about.
 */
function assertQueryMode(content: { kind: string; dataAccess: ContentDataAccess }): void {
  try {
    assertArtifactDataAccess(
      content,
      "query",
      "Artifact is not configured for data queries"
    );
  } catch (error) {
    if (error instanceof Error) throw tagBridgeError(error, "not_query_mode");
    throw error;
  }
}

/**
 * Turn a thrown failure into the typed bridge response (#1787).
 *
 * `handleError` still runs — it is what writes the full technical detail to the
 * server logs — but its generic `message` is replaced by the code's own text, so
 * the page gets something it can act on. `detail` (upstream SQL/MCP text) is
 * attached ONLY for a `query_error` raised for a requester who may edit the
 * artifact; a plain reader gets the code and nothing more — except when the
 * detail is this server's own validation message about the reader's request.
 */
function buildQueryFailure(
  error: unknown,
  requestId: string,
  mayEdit: boolean
): QueryArtifactDataFailure {
  const classified = classifyQueryFailure(error);
  handleError(error, "Failed to query artifact data", {
    context: "queryArtifactData",
    requestId,
    operation: "queryArtifactData",
    metadata: { bridgeCode: classified.code, upstreamDetail: classified.detail },
  });
  const detail =
    classified.code === "query_error" && (mayEdit || classified.detailIsViewerSafe)
      ? classified.detail
      : undefined;
  return {
    isSuccess: false,
    message: detail ?? artifactBridgeErrorMessage(classified.code),
    code: classified.code,
    ...(classified.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: classified.retryAfterSeconds }
      : {}),
    ...(detail ? { detail } : {}),
  };
}

export async function queryArtifactData(
  input: QueryArtifactDataInput
): Promise<QueryArtifactDataOutcome> {
  const requestId = generateRequestId();
  const timer = startTimer("queryArtifactData");
  const log = createLogger({ requestId, action: "queryArtifactData" });
  // Whether the requester may EDIT this artifact, resolved as soon as both the
  // requester and the object are known. It gates `detail` in the catch below, so
  // it must default to false: every failure BEFORE the object is resolved (no
  // session, rate limited, not viewable) is answered without upstream text.
  let mayEdit = false;
  // ONE end-to-end server budget, armed BEFORE any preflight work (#1788).
  //
  // This used to be armed inside `callQueryData`, so session resolution, the
  // `contentService.get` visibility check, the version lookup and the connector
  // config read all ran outside it. The sandbox host's clock, by contrast,
  // covers everything from the moment the request is dispatched — so a slow
  // preflight plus a full 30s execution could exceed the host's 45s, and the
  // host would discard an answer for a query that was still running. The server
  // must always lose that race BY CONSTRUCTION, not by assuming preflight is
  // fast, so the deadline starts here and what remains of it is what the
  // handshake and the execution get.
  const deadline = AbortSignal.timeout(QUERY_TIMEOUT_MS);

  try {
    // #1787: logged BEFORE authorization, so a session/rate-limit/validation
    // refusal is no longer an "Action started"-less log line with no contentId
    // to correlate it by.
    const contentId = validateContentId(input?.contentId);
    log.info("Action started: query artifact data", {
      contentId: sanitizeForLogging(contentId),
    });

    // Every preflight await RACES the deadline as one unit (#1788). Arming the
    // clock is not enough on its own: none of these calls takes an
    // AbortSignal, so without the race a single hung dependency (a wedged DB
    // pool, a stalled connector-config read) would leave this route pending
    // long after the frame had discarded the request — and the page would retry
    // while the original preflight was still running. Racing here bounds the
    // whole turn, whatever any one dependency does.
    //
    // `mayEdit` is assigned inside, so an abort leaves it at its fail-closed
    // `false` and the catch withholds upstream text, exactly as for any other
    // pre-object failure.
    // None of the preflight calls is cancellable, so the race bounds what the
    // CALLER waits for but cannot stop a stage that has already begun. Checking
    // between stages stops the closure from starting the NEXT one once the
    // budget is gone — otherwise a dependency slowdown leaves every abandoned
    // request still running version and connector-config lookups in the
    // background, and retries pile that work up behind the failures.
    const stopIfExpired = (): void => {
      if (deadline.aborted) throw deadline.reason;
    };

    const preflight = await withDeadline(
      (async () => {
        const { session, idToken } = await authorizeQueryRequest(contentId);
        const params = validateQueryParams(input);
        stopIfExpired();

        // Same session instance the gate above validated — never a second
        // resolve.
        const requester = await getUserRequester(requestId, session);
        // Keep the boundary fail-closed if requester resolution ever broadens.
        if (requester.kind !== "user" || requester.userId == null) {
          throw ErrorFactories.authNoSession();
        }

        // Shared 404 mask for missing/non-viewable content, exactly as the
        // record actions do — a viewer who cannot see the artifact learns
        // nothing.
        stopIfExpired();

        const content = await contentService.get(requester, contentId);
        mayEdit = canEdit(requester, content.ownerUserId);
        // The version resolution below is DB work of its own (#1789), so a
        // budget spent loading the object must not start it.
        stopIfExpired();
        // #1789: resolve WHICH version is running BEFORE the exclusivity gate —
        // the gate now judges that version's own mode, not the object's. A
        // version id that does not belong to this artifact is still refused.
        const rendered = await resolveRenderedVersionAccess(
          content,
          mayEdit,
          input?.versionId,
          log
        );
        // The exclusivity gate: `records` and `none` artifacts never reach the
        // data MCP (see the artifact-data.ts header for why).
        assertQueryMode({ kind: content.kind, dataAccess: rendered.dataAccess });
        const auditVersionId = rendered.versionId;
        stopIfExpired();

        const connectorId = await requirePsdDataConnectorId(stopIfExpired);
        return {
          idToken,
          params,
          // Returned narrowed: the `!= null` check above does not survive the
          // trip out of this closure, and the caller needs a plain number.
          userId: requester.userId,
          roles: requester.roles ?? [],
          content,
          auditVersionId,
          connectorId,
        };
      })(),
      deadline,
      // Nothing to release: preflight opens no connector. A late settle is
      // simply discarded.
      () => {}
    );
    const {
      idToken,
      params,
      userId,
      roles,
      content,
      auditVersionId,
      connectorId,
    } = preflight;

    log.debug("Artifact data query accepted", {
      contentId: content.id,
      sqlLength: params.sql.length,
      limit: params.limit,
      offset: params.offset,
      auditVersionId,
    });

    // `getConnectorTools` runs `requireUserAccess` internally (allow list, else
    // staff/administrator), so a student or an out-of-list viewer is refused
    // BEFORE any request reaches the data MCP.
    const result = await callQueryData({
      deadline,
      connectorId,
      userId,
      roles,
      idToken,
      sql: params.sql,
      limit: params.limit,
      offset: params.offset,
      // The audit line the data MCP records for this call — naming the version
      // that is actually running, not whatever the working head happens to be.
      reason: `atrium artifact ${content.id} v${auditVersionId ?? "none"}`,
    });

    timer({ status: "success" });
    log.info("Artifact data query completed", {
      contentId: content.id,
      userId,
      returnedCount: result.returnedCount,
      truncated: result.truncated,
    });
    // Built as a literal rather than via `createSuccess`, whose return type is
    // the whole `ActionState` union — including a failure arm that carries no
    // bridge `code` and so does not satisfy `QueryArtifactDataOutcome`.
    return {
      isSuccess: true,
      message: "Artifact data query completed",
      data: result,
    };
  } catch (error) {
    timer({ status: "error" });
    // `handleError` (inside) keeps the full technical detail server-side; the
    // page gets a typed code plus, for an editor, the upstream SQL message.
    return buildQueryFailure(error, requestId, mayEdit);
  }
}
