/**
 * The numeric limits the `AtriumData` bridge enforces, in ONE place (#1792).
 *
 * Every one of these was previously a literal inside the module that enforced
 * it, and none of them appeared in the model-facing authoring guidance. That is
 * the shape of failure #1792 is about: a model writes a query with no `limit`,
 * the action quietly applies 200, and an unaggregated dashboard renders a
 * confidently wrong number with nothing to diagnose.
 *
 * `lib/content/atrium-data-contract.ts` interpolates these constants into the
 * prompt text, so the guidance cannot state a number the code does not enforce.
 *
 * This module is deliberately dependency-free: the query action (server), the
 * sandbox parent bridge (client component), and the tests all import it. The
 * sandbox HOST (`infra/sandbox-host/render.html`) is a static asset with no
 * bundler and cannot — its literals are pinned against these values by
 * `tests/unit/lib/content/atrium-data-contract.test.ts`.
 */

/** `limit` applied when the page omits it — NOT the maximum. */
export const ARTIFACT_QUERY_DEFAULT_LIMIT = 200;

/**
 * Upper bound on `limit`, mirroring the data MCP's own `JSON_ROW_LIMIT`. An
 * out-of-range page value is clamped here rather than round-tripped.
 */
export const ARTIFACT_QUERY_MAX_LIMIT = 2_000;

/** Upper bound on `offset`. */
export const ARTIFACT_QUERY_MAX_OFFSET = 1_000_000;

/** Upper bound on the page-supplied SQL string, in characters. */
export const ARTIFACT_QUERY_MAX_SQL_LENGTH = 8_000;

/** Queries allowed per viewer, per artifact, per {@link ARTIFACT_QUERY_RATE_WINDOW_MS}. */
export const ARTIFACT_QUERY_RATE_LIMIT = 60;

/** The rate-limit window. */
export const ARTIFACT_QUERY_RATE_WINDOW_MS = 60 * 1000;

/** How many bridge requests the parent runs at once; the rest QUEUE. */
export const ARTIFACT_MAX_CONCURRENT_DATA_REQUESTS = 6;

/**
 * The most bridge requests that may be outstanding (in flight AND queued) at
 * once, from either side. Past this a call is REFUSED with `too_many_requests`.
 * Mirrors the sandbox host's `MAX_PENDING_DATA_REQUESTS`.
 */
export const ARTIFACT_MAX_PENDING_DATA_REQUESTS = 32;

/**
 * The frame's per-query clock, armed at DISPATCH (not at post). Past it the
 * call rejects with `timeout`.
 */
export const ARTIFACT_QUERY_CLIENT_TIMEOUT_MS = 45_000;

/**
 * The frame's per-request clock for record ops (`submit` / `list`), also armed
 * at dispatch. Mirrors the sandbox host's `DATA_REQUEST_TIMEOUT_MS`.
 */
export const ARTIFACT_RECORD_CLIENT_TIMEOUT_MS = 10_000;
