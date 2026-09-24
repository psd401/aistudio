/**
 * Typed failure codes for the Atrium artifact data bridge (#1787).
 *
 * Before this module every bridge failure reached artifact code as the single
 * string "Artifact data request failed". A dashboard with a SQL typo therefore
 * looked identical to "you are not signed in", so models were told to render a
 * no-access state for what was really their own broken SQL, and the author
 * previewing the page had nothing to go on either.
 *
 * The codes below are the CONTRACT between three layers:
 *   1. `actions/db/atrium/artifact-query.ts` classifies its own failures into one.
 *   2. `components/atrium/ArtifactSandbox.tsx` carries `{ code, message,
 *      retryAfterSeconds? }` across the postMessage bridge.
 *   3. `infra/sandbox-host/render.html` rejects `AtriumData.query(...)` with an
 *      `Error` whose `.code` is one of these and whose `.message` is readable.
 *
 * WHY THIS LEAKS NOTHING NEW: every code describes the VIEWER'S OWN request,
 * evaluated against the viewer's own permissions, and the frame that receives it
 * has no egress at all (`connect-src 'none'`, no `allow-same-origin`, opaque
 * origin). The one code that can carry upstream text — `query_error` — is gated
 * separately server-side: the Postgres/MCP message is attached only when the
 * requester may EDIT the artifact (i.e. could read and run that SQL from the Code
 * tab anyway). Plain readers get the code with a generic message.
 *
 * This module is deliberately dependency-free so the client bridge, the server
 * action, and the tests can all import it.
 */

/** The closed set of bridge failure codes. Order is not significant. */
export const ARTIFACT_BRIDGE_ERROR_CODES = [
  /** No session, or the session carries no usable ID token. */
  "unauthenticated",
  /** Signed in, but not allowed to see this artifact or use the data server. */
  "forbidden",
  /**
   * The artifact's `dataAccess` mode does not permit this operation — almost
   * always "you called `query` on an artifact that is not in `query` mode",
   * which is why it is named for that case; it also covers a record op on a
   * query-mode artifact. Fix the ARTIFACT's mode, not the code.
   */
  "not_query_mode",
  /** Per-viewer, per-artifact budget exhausted. Carries `retryAfterSeconds`. */
  "rate_limited",
  /** The request did not answer within the bridge's budget. */
  "timeout",
  /** The query itself was rejected — bad SQL, unknown column, bad arguments. */
  "query_error",
  /** Too many bridge calls are already in flight from this page. */
  "too_many_requests",
  /** Anything else: connector unconfigured, upstream down, unexpected shape. */
  "unavailable",
] as const;

export type ArtifactBridgeErrorCode =
  (typeof ARTIFACT_BRIDGE_ERROR_CODES)[number];

/**
 * The default human-readable message for each code. Used whenever a layer has
 * no more specific text (and as the total fallback if a code ever arrives that
 * this build does not know).
 */
export const ARTIFACT_BRIDGE_ERROR_MESSAGES: Readonly<
  Record<ArtifactBridgeErrorCode, string>
> = {
  unauthenticated:
    "Your session has expired. Reload the page to sign in again.",
  forbidden: "You do not have access to this data.",
  not_query_mode:
    "This artifact is not configured for live data queries.",
  rate_limited: "Too many data requests. Try again in a moment.",
  timeout: "The data request timed out.",
  query_error: "The data query failed.",
  too_many_requests:
    "Too many data requests are already running on this page.",
  unavailable: "The data service is unavailable.",
};

/**
 * Upper bound on any message that crosses a trust boundary (into the frame, or
 * into a model's context). Postgres errors are short; a pathological one must
 * not become an allocation or context-window amplifier.
 */
export const MAX_ARTIFACT_BRIDGE_ERROR_MESSAGE_LENGTH = 500;

export function isArtifactBridgeErrorCode(
  value: unknown
): value is ArtifactBridgeErrorCode {
  return (
    typeof value === "string" &&
    (ARTIFACT_BRIDGE_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** The default message for `code`, falling back to `unavailable`'s. */
export function artifactBridgeErrorMessage(code: unknown): string {
  return isArtifactBridgeErrorCode(code)
    ? ARTIFACT_BRIDGE_ERROR_MESSAGES[code]
    : ARTIFACT_BRIDGE_ERROR_MESSAGES.unavailable;
}

/**
 * Normalize a message before it crosses a boundary: flatten it to a single line
 * (an upstream Postgres error is multi-line, and newlines read as injected
 * structure inside a model prompt or a log line) and bound the length.
 *
 * Control characters AND ordinary whitespace runs collapse to one space, so the
 * result is stable regardless of how the upstream laid its message out.
 *
 * Returns `null` for anything that normalizes to empty, so callers can fall back
 * to the code's default message rather than showing a blank failure state.
 */
export function boundBridgeErrorMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const flattened = message
    // eslint-disable-next-line no-control-regex -- deliberately matching C0/C1.
    .replace(/[\u0000-\u001F\u007F-\u009F\s]+/g, " ")
    .trim();
  if (!flattened) return null;
  return flattened.length > MAX_ARTIFACT_BRIDGE_ERROR_MESSAGE_LENGTH
    ? `${flattened.slice(0, MAX_ARTIFACT_BRIDGE_ERROR_MESSAGE_LENGTH - 1)}…`
    : flattened;
}
