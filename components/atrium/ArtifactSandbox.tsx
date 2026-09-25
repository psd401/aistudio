"use client";

/**
 * Atrium artifact sandbox (#1052, Epic #1059, Phase 2, spec §19.2 / §28.1)
 *
 * Renders UNTRUSTED artifact code (agent- or human-authored HTML/JS) inside a
 * cross-origin sandboxed iframe. This is the single highest-risk surface in the
 * Atrium feature, so the containment is non-negotiable:
 *
 * - The iframe `src` points at a SEPARATE origin (`ATRIUM_SANDBOX_ORIGIN`) — a
 *   distinct subdomain / distribution that shares NO cookies, storage, or
 *   localStorage with the AI Studio app origin.
 * - `sandbox="allow-scripts"` and explicitly NEVER `allow-same-origin`. With
 *   `allow-scripts` but no `allow-same-origin`, the framed document is forced
 *   into an opaque origin: even though it is served from the sandbox origin, it
 *   cannot read that origin's cookies/storage either, and it can never reach the
 *   app origin. (Granting both flags simultaneously is the documented escape
 *   hatch that lets framed code remove its own sandbox — we never do that.)
 * - `referrerPolicy="no-referrer"` so the artifact host never learns the app URL.
 * VERSION SWITCHING: callers that need a clean execution environment per version
 * (e.g. `ArtifactCanvas`) remount this component with a React `key` tied to the
 * version id. Each version therefore gets a fresh iframe + fresh `onLoad` →
 * `postCode`, with no shared JS state from the prior version. This component does
 * NOT implement an in-place "re-post on code change" path: a `code` change without
 * a remount is not a supported usage (both current callers either pass a single
 * code value or remount via `key`), and adding one would silently share execution
 * state across versions.
 *
 * - The artifact code is delivered by `postMessage` AFTER the frame loads — code
 *   is never embedded in the iframe `src`, never serialized into app-origin HTML,
 *   and never passed to `dangerouslySetInnerHTML`. The post uses `targetOrigin:
 *   "*"` because a sandbox frame with `allow-scripts` and no `allow-same-origin`
 *   runs in an OPAQUE origin that a concrete targetOrigin can never match (the
 *   message would be silently dropped). Authentication is inverted: the host page
 *   accepts the message only from an allowlisted `event.origin`. The payload is
 *   the untrusted code itself, so `"*"` leaks no app secret. See `postCode` below.
 * - The reverse-direction artifact data bridge carries three operations —
 *   `submit` / `list` (the artifact record store, #1516) and `query`
 *   (viewer-scoped, read-only PSD data, #1705). Which ones a given artifact may
 *   use is enforced TWICE, and both layers must agree (#1712): this component
 *   refuses any op that does not match the `dataAccess` mode the page was
 *   LOADED with, and each Server Action independently refuses unless the mode
 *   the artifact CURRENTLY holds matches. The parent pin matters because the
 *   owner can flip `data_access` at any time (settings, REST PATCH, MCP): a
 *   page loaded in `query` mode holds queried rows in memory, so without the
 *   pin a mid-session flip to `records` would let that page submit them back to
 *   a store the author can read — exactly the exfiltration loop migration 179
 *   closes. A mode change therefore only takes effect on a fresh load, which
 *   starts with no queried data. This component still never GRANTS anything —
 *   it can only narrow. Requests are accepted only when
 *   `event.source === iframeRef.current?.contentWindow`. Opaque-origin frames
 *   report `event.origin === "null"`, so origin is deliberately NOT the bridge
 *   authenticator. The trusted `contentId` comes only from this component's
 *   props; any similarly named request field is ignored. Only authenticated
 *   callers explicitly enable the bridge and work is bounded per frame.
 *   Responses require `targetOrigin: "*"` because the receiving frame is
 *   opaque-origin.
 * - FAILURES ARE TYPED (#1787). Each rejection carries an
 *   `ArtifactBridgeErrorCode` — `unauthenticated | forbidden | not_query_mode |
 *   rate_limited | timeout | query_error | too_many_requests | unavailable` —
 *   plus a readable message, because one generic string made a SQL typo look
 *   identical to "you do not have access" and artifacts rendered the wrong
 *   failure state for years of debugging time. This discloses nothing new: every
 *   code describes the VIEWER'S OWN request under the viewer's own permissions,
 *   and the frame has no egress (`connect-src 'none'`). Upstream database text
 *   rides along only under `query_error`, and only when the SERVER decided the
 *   requester may edit this artifact (see `artifact-query.ts`) — this component
 *   forwards that decision, it never makes it.
 *
 * When the sandbox origin is not configured (or, defensively, resolves to the
 * app origin) the component fails CLOSED — it renders an "unavailable" notice
 * instead of falling back to any same-origin rendering of the untrusted code.
 *
 * The host page at `${origin}/render` is responsible for applying its own strict
 * CSP and injecting the posted code; see the CDK sandbox stack and the static
 * host page. This component only establishes the cross-origin boundary and the
 * delivery channel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeOrigin } from "@/lib/content/artifact-sandbox-config";
import {
  artifactBridgeErrorMessage,
  boundBridgeErrorMessage,
  isArtifactBridgeErrorCode,
  type ArtifactBridgeErrorCode,
} from "@/lib/content/artifact-bridge-errors";
import {
  artifactQueryCodeForStatus,
  artifactQueryRoutePath,
  isArtifactQueryFailureBody,
  type ArtifactQueryRequestBody,
} from "@/lib/content/artifact-query-transport";
import { toBase64Utf8 } from "@/lib/content/code-encoding-browser";
import type { ContentDataAccess } from "@/lib/content/types";
import type { ArtifactDataPayload } from "@/lib/db/types/jsonb";

type FrameLoadStatus = "loading" | "loaded" | "error";
/**
 * Whether the framed host has acknowledged the render:
 *  - "pending"  : code posted (or being retried); no successful ack yet.
 *  - "rendered" : the host acked `{ ok: true }` — the artifact is live.
 *  - "error"    : no successful ack within the retry budget (the "waiting
 *                 forever" guard). An `{ ok: false }` ack is treated as a
 *                 transient failure — retries continue until the budget runs out.
 */
type RenderStatus = "pending" | "rendered" | "error";

/**
 * Re-post the artifact code every RENDER_RETRY_MS until the host acks. The very
 * first post can miss: an SSR-rendered reader iframe may finish loading BEFORE
 * React hydrates and attaches `onLoad`, so the single onLoad-driven post never
 * fires (the "Waiting for artifact…" host placeholder then sticks forever). The
 * host has no retry of its own, so the parent drives redelivery until the render
 * acknowledgement arrives — at which point retries stop (the host re-renders
 * idempotently, but we never post more than the first ack requires).
 */
const RENDER_RETRY_MS = 300;
/**
 * How many posts to attempt before giving up and showing an explicit error
 * instead of waiting forever. 40 × 300ms ≈ 12s — generous enough that a slow
 * host page still acks first, but bounded so a genuinely dead sandbox surfaces a
 * failure notice rather than a perpetual "Waiting for artifact…".
 */
const RENDER_MAX_ATTEMPTS = 40;
/**
 * How many bridge requests the parent will have in flight at once (#1788).
 *
 * This used to be a hard cap of 8 that REJECTED the 9th call outright, which was
 * the wrong shape twice over: a dashboard with nine panels got a generic failure
 * on one of them for no reason a viewer could act on, and the cap never bought
 * anything anyway because Server Actions were dispatched one at a time — the
 * real concurrency was 1. Now `query` goes over `fetch` (see
 * `lib/content/artifact-query-transport.ts`), so requests genuinely overlap, and
 * excess work QUEUES behind this limit instead of being refused.
 */
const MAX_CONCURRENT_DATA_REQUESTS = 6;
/**
 * Record ops (`submit` / `list`) run strictly one at a time.
 *
 * They still travel over Server Actions, which the App Router dispatches one at
 * a time regardless — so a higher limit here would not make them overlap. It
 * would only create a SECOND, invisible queue after the dispatch ack, and the
 * ack's whole job is to tell the frame "your request has started" so it can
 * time the server rather than the wait. Acking six record ops that are really
 * queued in Next would restart the frame's 10s clock on requests that have not
 * begun: a later `submit` would time out in the frame, write anyway, and the
 * author's retry would duplicate the record.
 *
 * Queries do not have this problem — they go over `fetch`, which genuinely runs
 * them in parallel (see `fetchArtifactQuery`).
 */
const MAX_CONCURRENT_RECORD_REQUESTS = 1;
/**
 * The sandbox host's `MAX_PENDING_DATA_REQUESTS` (infra/sandbox-host/render.html),
 * mirrored here so the parent's total capacity is derived from it rather than
 * guessed alongside it. The frame is the binding constraint: it refuses to hold
 * more than this many promises open at once, whatever the parent would accept.
 */
const MAX_PENDING_DATA_REQUESTS_IN_FRAME = 32;
/**
 * The most requests this parent will hold at once, in flight AND queued.
 *
 * Deliberately a TOTAL rather than a queue depth, and deliberately the host's
 * own number. The two layers count different things — the frame counts every
 * promise it is holding open, the parent could count only what waits behind the
 * active slots — so any queue-depth constant has to be reconciled against the
 * concurrency limit that happens to apply, and gets it wrong the moment there
 * is more than one such limit. Capping the total instead is correct for every
 * lane by construction: a query-mode mount reaches 6 + 26 and a records-mode
 * mount reaches 1 + 31, and both refuse exactly the request the frame would.
 */
const MAX_OUTSTANDING_DATA_REQUESTS = MAX_PENDING_DATA_REQUESTS_IN_FRAME;
const MAX_DATA_PAYLOAD_BYTES = 8 * 1024;
const MAX_DATA_PAYLOAD_VALUES = 8_192;
const MAX_DATA_PAYLOAD_STRING_CODE_UNITS = MAX_DATA_PAYLOAD_BYTES;
/**
 * The fallback message for a bridge failure that carries no better text.
 *
 * #1787: this used to be the ONLY thing an artifact could ever learn about a
 * failure — a SQL typo, "you are signed out", and a rate limit were the same
 * string. Every failure now also carries an `ArtifactBridgeErrorCode`, and the
 * record ops (submit/list), which have no typed classification of their own,
 * still answer with this generic text under the `unavailable` code.
 */
const DATA_BRIDGE_ERROR_MESSAGE = "Artifact data request failed";
const DATA_NAMESPACE_RE = /^[a-z0-9_-]{1,64}$/;
/**
 * Parent-side mirror of the query action's SQL cap (#1705). The action remains
 * the authority and re-validates; this only stops an oversized string from being
 * serialized into a Server Action payload at all.
 */
const MAX_QUERY_SQL_LENGTH = 8_000;
const REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ArtifactSandboxBaseProps {
  /**
   * The untrusted artifact code (HTML/JS). It is sent to the cross-origin host
   * via postMessage and never touches the app-origin DOM.
   */
  code: string;
  /**
   * The sandbox render URL (`<origin>/render`), resolved SERVER-SIDE from the
   * `ATRIUM_SANDBOX_ORIGIN` runtime env (via `getArtifactSandboxRenderUrl()`) and
   * passed in as a prop. Resolving server-side avoids any build-time
   * `NEXT_PUBLIC_*` value — the CDK deploy injects the origin and it flows through
   * here. `null`/omitted means the sandbox is unconfigured (or resolved to the
   * app origin) → the component fails CLOSED and renders no executable frame.
   */
  src?: string | null;
  /** Accessible title for the preview frame. */
  title?: string;
  /** Optional className for the iframe (sizing/styling). */
  className?: string;
  /**
   * Called for every preview failure worth reporting (#1787): a rejected
   * `AtriumData` call, and any uncaught error / unhandled rejection the frame
   * forwards. Optional — surfaces with nowhere to put a diagnostic (thumbnails,
   * embeds) simply omit it and nothing is collected.
   *
   * This component stores nothing itself. `ArtifactCanvas` buffers the entries
   * so the next chat turn can carry them to the model that wrote the code.
   */
  onDiagnostic?: (diagnostic: ArtifactSandboxDiagnostic) => void;
}

/**
 * The bridge is absent unless a trusted caller deliberately enables it and
 * supplies the content identity. The disabled variant cannot carry a contentId,
 * which keeps anonymous/public-reader wiring fail-closed at the type boundary.
 *
 * The enabling branch also REQUIRES `dataAccess` (#1712) — the artifact's mode
 * as read when this page was rendered. It is a required member rather than an
 * optional one so a caller cannot enable the bridge without pinning a mode; an
 * absent value at runtime still fails closed (see `isOpAllowedByLoadedMode`).
 */
export type ArtifactSandboxProps = ArtifactSandboxBaseProps &
  (
    | {
        dataBridgeEnabled: true;
        contentId: string;
        dataAccess: ContentDataAccess;
        /**
         * The version whose code this frame is running (#1787). Trusted — it
         * comes from the caller's own state, never from the frame — and used
         * only to name the version in the data MCP's audit line, in place of
         * the working head (which is the wrong answer on a published page or
         * while the canvas previews an older version).
         */
        versionId?: string;
      }
    | {
        dataBridgeEnabled?: false;
        contentId?: never;
        dataAccess?: never;
        versionId?: never;
      }
  );

interface RenderAck {
  type: "atrium-artifact-rendered";
  ok: boolean;
  error?: string;
}

interface SubmitDataRequest {
  type: "atrium-artifact-data-request";
  requestId: string;
  op: "submit";
  namespace: string;
  payload: ArtifactDataPayload;
}

interface ListDataRequest {
  type: "atrium-artifact-data-request";
  requestId: string;
  op: "list";
  namespace: string;
  limit?: number;
  scope?: "all" | "mine";
}

/**
 * Viewer-scoped PSD data read (#1705). The page supplies ONLY `sql`, `limit`,
 * and `offset` — the tool name, `format`, `export`, `view_results` and the audit
 * `reason` are all forced by `queryArtifactData` server-side. A request carrying
 * any of those extra fields is not rejected for it; the fields are simply never
 * copied out of the message (see `handleDataRequest`), so they cannot influence
 * the call. Unlike submit/list this op carries no namespace.
 */
interface QueryDataRequest {
  type: "atrium-artifact-data-request";
  requestId: string;
  op: "query";
  sql: string;
  limit?: number;
  offset?: number;
}

type ArtifactDataRequest =
  | SubmitDataRequest
  | ListDataRequest
  | QueryDataRequest;

type ArtifactDataResponse =
  | {
      type: "atrium-artifact-data-response";
      requestId: string;
      ok: true;
      data: unknown;
    }
  | ({
      type: "atrium-artifact-data-response";
      requestId: string;
      ok: false;
    } & ArtifactDataFailure);

/**
 * The typed failure half of a bridge response (#1787). `code` is the closed
 * enum the frame re-exposes as `err.code`; `error` is a human-readable message
 * (the code's default, or — for `query_error` raised for an EDITOR — the
 * upstream Postgres/MCP text the action decided to forward).
 */
interface ArtifactDataFailure {
  code: ArtifactBridgeErrorCode;
  error: string;
  /** Seconds to wait before retrying. `rate_limited` only. */
  retryAfterSeconds?: number;
}

/**
 * A preview failure worth telling somebody about (#1787) — the bridge rejections
 * the artifact swallowed, plus whatever the frame itself threw. Reported to the
 * caller so `ArtifactCanvas` can buffer it for the chat; this component keeps no
 * state of its own for it.
 */
export interface ArtifactSandboxDiagnostic {
  kind: "data" | "script";
  code?: ArtifactBridgeErrorCode;
  message: string;
  /** The SQL that failed, for a `query` rejection. */
  sql?: string;
}

/**
 * The frame's forwarded uncaught error / unhandled rejection (render.html) — or,
 * with `kind: "data"`, a bridge failure the FRAME raised itself (its own
 * timeout or pending-request cap), which the parent never sees otherwise.
 */
interface ArtifactFrameError {
  type: "atrium-artifact-error";
  message: string;
  kind?: unknown;
  code?: unknown;
  sql?: unknown;
}

/** The diagnostic a forwarded frame error becomes. `message` is already bounded. */
function frameErrorDiagnostic(
  data: ArtifactFrameError,
  message: string
): ArtifactSandboxDiagnostic {
  // An unrecognized code is not trusted as a data failure; it stays a plain
  // script error rather than reaching the chat as an unvalidated code.
  if (data.kind !== "data" || !isArtifactBridgeErrorCode(data.code)) {
    return { kind: "script", message };
  }
  const sql = typeof data.sql === "string" ? boundBridgeErrorMessage(data.sql) : "";
  return { kind: "data", code: data.code, message, ...(sql ? { sql } : {}) };
}

function isArtifactFrameError(data: unknown): data is ArtifactFrameError {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "atrium-artifact-error" &&
    typeof (data as { message?: unknown }).message === "string"
  );
}

/** Narrow an unknown postMessage payload to the host's render acknowledgement. */
function isRenderAck(data: unknown): data is RenderAck {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "atrium-artifact-rendered"
  );
}

function isSubmitPayload(payload: unknown): payload is ArtifactDataPayload {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Bound parent-side work before Next serializes a payload for the Server Action.
 * The action remains the authority and repeats its full validation; this mirror
 * prevents an artifact from using the action transport itself as an oversized
 * allocation/traffic amplifier.
 */
function hasBoundedJsonStructure(value: unknown): boolean {
  type ValidationFrame =
    | { kind: "value"; value: unknown }
    | { kind: "leave"; value: object };

  const pending: ValidationFrame[] = [{ kind: "value", value }];
  const activePath = new WeakSet<object>();
  let discoveredValues = 1;
  let discoveredStringCodeUnits = 0;

  const countString = (next: string): void => {
    discoveredStringCodeUnits += next.length;
    if (discoveredStringCodeUnits > MAX_DATA_PAYLOAD_STRING_CODE_UNITS) {
      throw new Error("payload string bound exceeded");
    }
  };
  const enqueue = (next: unknown): void => {
    discoveredValues += 1;
    if (discoveredValues > MAX_DATA_PAYLOAD_VALUES) {
      throw new Error("payload value bound exceeded");
    }
    pending.push({ kind: "value", value: next });
  };
  const enterContainer = (next: object): void => {
    if (activePath.has(next)) throw new Error("payload cycle");
    activePath.add(next);
    pending.push({ kind: "leave", value: next });
  };

  try {
    while (pending.length > 0) {
      const frame = pending.pop()!;
      if (frame.kind === "leave") {
        activePath.delete(frame.value);
        continue;
      }

      const current = frame.value;
      if (current === null || typeof current === "boolean") continue;
      if (typeof current === "string") {
        countString(current);
        continue;
      }
      if (typeof current === "number" && Number.isFinite(current)) continue;
      if (typeof current !== "object") return false;

      if (Array.isArray(current)) {
        enterContainer(current);
        for (const item of current) enqueue(item);
        continue;
      }

      if (!isPlainJsonObject(current)) return false;
      enterContainer(current);
      const record = current as Record<string, unknown>;
      for (const key in record) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          countString(key);
          enqueue(record[key]);
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

function isPayloadWithinBridgeBounds(payload: ArtifactDataPayload): boolean {
  if (!hasBoundedJsonStructure(payload)) return false;
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized || serialized.length > MAX_DATA_PAYLOAD_BYTES) return false;
    return new TextEncoder().encode(serialized).byteLength <= MAX_DATA_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

/**
 * Mirrors `normalizeBoundedInteger` in the query action: an omitted count is
 * fine, but a supplied one must be a finite, non-negative number. Narrowing
 * here keeps the bridge fail-fast, so a request the server would reject never
 * serializes a Server Action payload.
 */
function isOptionalCount(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function hasValidQueryOptions(candidate: Record<string, unknown>): boolean {
  // Length is checked before trimming and emptiness after, exactly as
  // `validateSql` does server-side, so whitespace-only SQL is refused here
  // rather than travelling to an action that will only reject it later.
  return (
    typeof candidate.sql === "string" &&
    candidate.sql.length <= MAX_QUERY_SQL_LENGTH &&
    candidate.sql.trim().length > 0 &&
    isOptionalCount(candidate.limit) &&
    isOptionalCount(candidate.offset)
  );
}

function hasValidListOptions(candidate: Record<string, unknown>): boolean {
  const validLimit =
    candidate.limit === undefined ||
    (typeof candidate.limit === "number" && Number.isFinite(candidate.limit));
  const validScope =
    candidate.scope === undefined ||
    candidate.scope === "all" ||
    candidate.scope === "mine";
  return validLimit && validScope;
}

/** Narrow an unknown payload to the three artifact data request operations. */
function isArtifactDataRequest(data: unknown): data is ArtifactDataRequest {
  if (typeof data !== "object" || data === null) return false;

  const candidate = data as Record<string, unknown>;
  if (
    candidate.type !== "atrium-artifact-data-request" ||
    typeof candidate.requestId !== "string" ||
    !REQUEST_ID_RE.test(candidate.requestId)
  ) {
    return false;
  }

  // `query` reads the PSD data connector and addresses no record namespace, so
  // the namespace requirement is scoped to the two record ops rather than
  // applied to every request.
  if (candidate.op === "query") {
    return hasValidQueryOptions(candidate);
  }

  if (typeof candidate.namespace !== "string") return false;

  if (candidate.op === "submit") {
    return isSubmitPayload(candidate.payload);
  }

  if (candidate.op === "list") {
    return hasValidListOptions(candidate);
  }

  return false;
}

function dataBridgeFailure(
  requestId: string,
  failure: ArtifactDataFailure
): ArtifactDataResponse {
  return {
    type: "atrium-artifact-data-response",
    requestId,
    ok: false,
    ...failure,
  };
}

/** A failure with no per-case text: the code's own default message. */
function codedFailure(code: ArtifactBridgeErrorCode): ArtifactDataFailure {
  return { code, error: artifactBridgeErrorMessage(code) };
}

/**
 * The record ops (`submit` / `list`) have no typed classification server-side,
 * so they keep exactly the behaviour they had before #1787 — one generic string
 * — under the `unavailable` code. Only `query` carries real codes today.
 */
const RECORD_OP_FAILURE: ArtifactDataFailure = {
  code: "unavailable",
  error: DATA_BRIDGE_ERROR_MESSAGE,
};

/** A query the bridge refused as malformed or oversized, before any server call. */
const MALFORMED_QUERY_FAILURE: ArtifactDataFailure = {
  code: "query_error",
  error: "The data request was rejected as malformed or oversized.",
};

/**
 * The `requestId` of a message that IS a data request by envelope (right type,
 * well-formed id) but failed `isArtifactDataRequest` — empty or oversized SQL, a
 * negative `limit`, a bad record payload. Such a request still gets an answer:
 * dropping it left `AtriumData.*` waiting out its own timeout and reporting
 * `timeout` for what is really a bad argument, with no preview diagnostic.
 */
function malformedDataRequestId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== "atrium-artifact-data-request") return null;
  const requestId = candidate.requestId;
  return typeof requestId === "string" && REQUEST_ID_RE.test(requestId)
    ? requestId
    : null;
}

/**
 * Per-op parent-side bounds. The Server Actions remain the authority and repeat
 * their own validation; this mirror keeps an oversized or malformed request from
 * being serialized into a Server Action payload at all.
 */
function isRequestWithinBridgeBounds(request: ArtifactDataRequest): boolean {
  if (request.op === "query") {
    // Length was already bounded by the narrowing predicate; nothing further to
    // check here — the SQL itself is the data MCP's business, not the bridge's.
    return true;
  }
  if (!DATA_NAMESPACE_RE.test(request.namespace)) return false;
  if (request.op === "submit") {
    return isPayloadWithinBridgeBounds(request.payload);
  }
  return true;
}

/**
 * The per-page-load mode pin (#1712).
 *
 * `dataAccess` is the artifact's mode as read when this page was RENDERED, not
 * when the request arrives. The server re-checks the mode the artifact holds at
 * request time, so a mode flipped after load fails BOTH checks (they disagree)
 * and only a fresh load — which has no queried rows in memory — can use the new
 * mode. `none`, and any value outside the three modes (including a missing one),
 * allow nothing.
 */
function isOpAllowedByLoadedMode(
  op: ArtifactDataRequest["op"],
  dataAccess: ContentDataAccess | undefined
): boolean {
  if (dataAccess === "query") return op === "query";
  if (dataAccess === "records") return op === "submit" || op === "list";
  return false;
}

/**
 * The message the parent posts when a queued request is actually DISPATCHED
 * (#1788). It carries nothing but the id: it exists so the frame can restart its
 * own timeout at the moment work begins, rather than counting queue time against
 * a budget the server never saw.
 */
const DATA_DISPATCH_ACK_TYPE = "atrium-artifact-data-ack";

/** One accepted request waiting behind the concurrency limit (#1788). */
interface QueuedBridgeRequest {
  request: ArtifactDataRequest;
  frameWindow: Window;
  /** `Date.now()` when this was accepted, for the queue-wait deadline below. */
  enqueuedAt: number;
}

/**
 * How long the parent will let a request WAIT before it refuses to dispatch it
 * at all (#1788).
 *
 * Deliberately SHORTER than the frame's own pre-ack budget
 * (`QUEUED_DISPATCH_TIMEOUT_MS`, 315s in render.html). The frame arms a clock
 * when the artifact posts and rejects the artifact's promise when it expires —
 * at which point the pending entry is gone and any later answer is discarded.
 * If the parent were still willing to dispatch after that, a queued `submit`
 * would COMMIT after the artifact had been told it timed out, and the author's
 * retry would create a duplicate record.
 *
 * So the parent must always give up first, by a margin wide enough to cover the
 * dispatch itself. A request past this deadline is answered `timeout` here
 * instead — which also reaches the artifact sooner than the frame's own clock
 * would have.
 */
const MAX_QUEUE_WAIT_MS = 300_000;

/** The outcome of one routed bridge action: data, or a typed failure. */
type BridgeActionOutcome =
  | { ok: true; data: unknown }
  | { ok: false; failure: ArtifactDataFailure };

/**
 * Narrow the query action's typed failure (#1787). The action returns the
 * closed `code` plus a message it has already decided is safe for THIS
 * requester (upstream SQL text only for an editor), so the bridge forwards both
 * verbatim rather than re-deciding. An older/unexpected payload with no valid
 * code degrades to `unavailable` with the generic message — never to a
 * success, and never to an unvalidated string.
 */
function queryActionFailure(result: {
  message?: unknown;
  code?: unknown;
  retryAfterSeconds?: unknown;
}): ArtifactDataFailure {
  if (!isArtifactBridgeErrorCode(result.code)) {
    // No code means this is not a payload #1787 produced. Its `message` has not
    // been through the action's disclosure gate, so it is NOT forwarded — the
    // pre-#1787 generic answer is the safe degradation.
    return { code: "unavailable", error: DATA_BRIDGE_ERROR_MESSAGE };
  }
  const code = result.code;
  const message = boundBridgeErrorMessage(result.message);
  const retryAfterSeconds = result.retryAfterSeconds;
  return {
    code,
    error: message ?? artifactBridgeErrorMessage(code),
    ...(code === "rate_limited" &&
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
      ? { retryAfterSeconds }
      : {}),
  };
}

/**
 * A failure body from the route whose `code` is missing or unrecognized — an
 * older/newer build, or a proxy that rewrote it. Still a body THIS route
 * produced, so it is answered as one (generically) rather than from the status.
 */
function isUncodedFailureBody(body: unknown): body is { message?: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { isSuccess?: unknown }).isSuccess === false
  );
}

/** A 2xx body from the query route: the action's own success envelope. */
function isQuerySuccessBody(body: unknown): body is { data: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { isSuccess?: unknown }).isSuccess === true &&
    "data" in (body as object)
  );
}

/**
 * Run one `query` over `fetch` instead of a Server Action (#1788).
 *
 * The App Router dispatches Server Actions strictly one at a time, so six
 * `Promise.all` queries used to run back to back (~6.5s on prod for what took
 * ~1.2s of actual work). `fetch` has no such queue, so the parent's own
 * concurrency limit is the only thing pacing them.
 *
 * The SQL travels base64 because the edge WAF's `SQLi_BODY` rule blocks request
 * bodies that look like SQL with a bare 403 — see the transport module.
 *
 * Both arms of the response are parsed: a non-2xx still carries the typed
 * `{ code, message }` body, and only when that body is missing or unparseable
 * (a WAF block, an ALB 502, middleware's own 401) is the code derived from the
 * status. A bare `response.json().catch(() => fallback)` would collapse those
 * into one indistinguishable failure.
 */
async function fetchArtifactQuery(
  request: QueryDataRequest,
  contentId: string,
  versionId: string | undefined
): Promise<BridgeActionOutcome> {
  const body: ArtifactQueryRequestBody = {
    sqlBase64: toBase64Utf8(request.sql),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.offset !== undefined ? { offset: request.offset } : {}),
    // Trusted prop, never a request field: it only names the version in the
    // data MCP's audit line (#1787).
    ...(versionId ? { versionId } : {}),
  };
  const response = await fetch(artifactQueryRoutePath(contentId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // The session cookie is what authenticates this call; it is a same-origin
    // request from the trusted parent, never from the opaque-origin frame.
    credentials: "same-origin",
    cache: "no-store",
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (response.ok) {
    return isQuerySuccessBody(parsed)
      ? { ok: true, data: parsed.data }
      : { ok: false, failure: { code: "unavailable", error: DATA_BRIDGE_ERROR_MESSAGE } };
  }
  // A body the route produced is answered by the body, even when its `code` is
  // one this build does not know: `queryActionFailure` already degrades that to
  // the pre-#1787 generic answer WITHOUT forwarding the unvetted message. Only
  // a response with no typed body at all falls back to the status.
  if (isArtifactQueryFailureBody(parsed) || isUncodedFailureBody(parsed)) {
    return { ok: false, failure: queryActionFailure(parsed) };
  }
  return {
    ok: false,
    failure: codedFailure(artifactQueryCodeForStatus(response.status)),
  };
}

/**
 * The record Server Action module, loaded once and remembered (#1788).
 *
 * The dynamic import keeps the server-only action graph out of fail-closed and
 * preview-only clients, but it also means the FIRST record op pays a chunk
 * download before anything can run. That download must happen BEFORE the parent
 * acknowledges dispatch: the ack restarts the frame's 10s clock, and on a slow
 * connection the chunk can land after that clock has already rejected the
 * artifact's promise — at which point `submitArtifactRecord` still runs, the
 * write commits, and the author's retry duplicates the record.
 *
 * Memoizing the promise is what lets the pump await readiness before acking
 * while `invokeBridgeAction` awaits the same settled promise for free.
 */
let recordActionsPromise: Promise<
  typeof import("@/actions/db/atrium/artifact-data")
> | null = null;

function loadRecordActions(): Promise<
  typeof import("@/actions/db/atrium/artifact-data")
> {
  // A FAILED import must not be remembered: the next attempt should retry the
  // chunk rather than replay a stale rejection for the life of the page.
  recordActionsPromise ??= import("@/actions/db/atrium/artifact-data").catch(
    (error: unknown) => {
      recordActionsPromise = null;
      throw error;
    }
  );
  return recordActionsPromise;
}

/**
 * Wait until the transport for this op can actually START work, so the dispatch
 * ack means what it says (#1788). Queries go over `fetch`, which needs nothing
 * loaded; record ops need their action chunk.
 */
async function awaitTransportReady(op: ArtifactDataRequest["op"]): Promise<void> {
  if (op === "query") return;
  await loadRecordActions();
}

/**
 * Route one validated request to its transport, copying ONLY the fields the op
 * is allowed to influence. `contentId` always comes from the trusted prop.
 *
 * `query` goes over `fetch` (#1788, above). The record ops stay on their Server
 * Actions: they are fired one at a time by an artifact reacting to a click, so
 * the action queue costs them nothing, and moving them would add a second
 * authenticated route for no measured benefit.
 *
 * The dynamic import keeps the server-only action graph out of fail-closed and
 * preview-only clients: Next resolves the `use server` module to action
 * references only when an enabled record request reaches the authenticated
 * parent, so a query-mode artifact never pulls in the record action references.
 */
async function invokeBridgeAction(
  request: ArtifactDataRequest,
  contentId: string,
  versionId: string | undefined
): Promise<BridgeActionOutcome> {
  if (request.op === "query") {
    return fetchArtifactQuery(request, contentId, versionId);
  }

  const { listArtifactRecords, submitArtifactRecord } = await loadRecordActions();
  if (request.op === "submit") {
    const result = await submitArtifactRecord({
      contentId,
      namespace: request.namespace,
      payload: request.payload,
      // Trusted prop, never a request field (#1789): it selects WHICH version's
      // data-access mode authorizes the write, so a Live page keeps the store it
      // was published with while the author's draft sits in another mode.
      ...(versionId ? { versionId } : {}),
    });
    return result.isSuccess
      ? { ok: true, data: result.data }
      : { ok: false, failure: RECORD_OP_FAILURE };
  }
  const result = await listArtifactRecords({
    contentId,
    namespace: request.namespace,
    limit: request.limit,
    scope: request.scope,
    // Trusted prop, never a request field (#1789) — see `submit` above.
    ...(versionId ? { versionId } : {}),
  });
  return result.isSuccess
    ? { ok: true, data: result.data }
    : { ok: false, failure: RECORD_OP_FAILURE };
}

interface ArtifactDataBridgeOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  origin: string | null;
  dataBridgeEnabled: boolean;
  contentId?: string;
  /** The artifact's data-access mode as of THIS page load (#1712). */
  dataAccess?: ContentDataAccess;
  /**
   * The version running in the frame. Names the version in the data MCP's audit
   * line (#1787) AND selects the data-access mode that authorizes every bridge
   * operation (#1789).
   */
  versionId?: string;
  /** Report a bridge rejection to the caller (#1787). Never throws. */
  onDiagnostic?: (diagnostic: ArtifactSandboxDiagnostic) => void;
}

/**
 * Which parent-side gate (if any) refuses this request, as a typed failure.
 *
 * #1787: these five refusals used to share one string with every server-side
 * failure, so an artifact could not tell "this page is not in query mode" (fix:
 * change the artifact's dataAccess) from "your SQL is wrong" (fix: the SQL) from
 * "you are firing too many queries at once" (fix: await them).
 */
function parentSideRefusal(args: {
  dataBridgeEnabled: boolean;
  contentId: string | undefined;
  request: ArtifactDataRequest;
  loadedDataAccess: ContentDataAccess | undefined;
  /** In flight PLUS queued — what the frame is holding open for this mount. */
  outstanding: number;
}): ArtifactDataFailure | null {
  const isQuery = args.request.op === "query";
  if (!args.dataBridgeEnabled || !args.contentId) {
    // The bridge was never enabled for this mount — nothing about the request
    // is wrong, there is simply nothing behind it.
    return RECORD_OP_FAILURE;
  }
  // The mode this page was LOADED with (#1712) — checked before the action so a
  // mode flipped under an open page cannot be used by it.
  if (!isOpAllowedByLoadedMode(args.request.op, args.loadedDataAccess)) {
    return isQuery
      ? codedFailure("not_query_mode")
      : {
          code: "not_query_mode",
          error: "This artifact's data mode does not allow record operations.",
        };
  }
  if (!isRequestWithinBridgeBounds(args.request)) {
    // Only `query` gets the sharper code: a record op has no typed vocabulary
    // of its own (see RECORD_OP_FAILURE), so it keeps its pre-#1787 answer.
    return isQuery ? MALFORMED_QUERY_FAILURE : RECORD_OP_FAILURE;
  }
  // #1788: only a FULL queue is refused now. Work beyond the concurrency limit
  // waits its turn instead of failing, which is what a dashboard with more
  // panels than the limit actually wants. The cap is the TOTAL outstanding, so
  // it lands on the same request the frame's own cap would, in either lane.
  if (args.outstanding >= MAX_OUTSTANDING_DATA_REQUESTS) {
    return codedFailure("too_many_requests");
  }
  return null;
}

/**
 * Dispatch queued requests up to the concurrency limit (#1788).
 *
 * Each dispatch also posts an `atrium-artifact-data-ack` to the frame. The
 * host's 45s query clock used to start when the page POSTED, so a request
 * that waited behind five others could time out having never run; the ack
 * restarts that clock at DISPATCH, which is the only moment the parent knows
 * the server is actually being asked.
 */
function useBridgePump(
  runBridgeRequest: (
    request: ArtifactDataRequest,
    frameWindow: Window
  ) => Promise<void>,
  inFlightDataRequestsRef: React.RefObject<number>,
  queuedDataRequestsRef: React.RefObject<QueuedBridgeRequest[]>,
  onDispatchAbandoned: (
    entry: QueuedBridgeRequest,
    code: ArtifactBridgeErrorCode
  ) => void
): () => void {
  return useCallback((): void => {
    // `step` recurses LEXICALLY rather than through a ref: a ref assigned in
    // the render body is a rules-of-hooks violation, and one assigned in an
    // effect leaves a window where a completing request reads a stale pump.
    // Everything `runBridgeRequest` closes over is fixed for the mount anyway
    // (the canvas keys the sandbox on contentId + version), so a drain started
    // by an earlier render can safely finish the queue it is draining.
    const step = (): void => {
      for (;;) {
        purgeExpiredQueued(queuedDataRequestsRef.current, onDispatchAbandoned);
        // Peek before taking: the limit depends on what is at the head. A
        // record op still travels over a Server Action, and the App Router
        // dispatches those ONE AT A TIME — the very serialization this issue is
        // about. Running six of them "concurrently" here would buy nothing and
        // would make the dispatch ack a lie: the parent would restart the
        // frame's 10s clock on five requests that are still sitting in Next's
        // client-side action queue, so a later `submit` could time out in the
        // frame and then write anyway, and the author's retry would create a
        // DUPLICATE record. One at a time makes "dispatched" mean "started".
        //
        // Query and record ops never mix on one mount: `isOpAllowedByLoadedMode`
        // pins the mount to a single mode, so this is one lane either way, not
        // two competing ones.
        const head = queuedDataRequestsRef.current[0];
        if (!head) break;
        const limit =
          head.request.op === "query"
            ? MAX_CONCURRENT_DATA_REQUESTS
            : MAX_CONCURRENT_RECORD_REQUESTS;
        if (inFlightDataRequestsRef.current >= limit) break;
        const next = queuedDataRequestsRef.current.shift();
        if (!next) break;
        // The slot is taken synchronously, so capacity accounting cannot race
        // with the await below.
        inFlightDataRequestsRef.current += 1;
        void (async () => {
          // Ack only once the transport can actually begin. The record path
          // lazily imports its Server Action chunk; acking first would restart
          // the frame's 10s clock while that download is still in flight, and a
          // slow chunk would let the frame reject the artifact's promise before
          // `submitArtifactRecord` had even been called -- the write would then
          // land anyway and a retry would duplicate it. Until the ack the frame
          // is still on its queue-tolerant pre-ack budget, which is the right
          // clock for "not started yet".
          try {
            await awaitTransportReady(next.request.op);
          } catch {
            // The chunk failed to load. Do NOT ack and do NOT run: acking would
            // start the frame's 10s post-dispatch clock, and `loadRecordActions`
            // has already cleared its memo on this rejection, so
            // `invokeBridgeAction` would kick off a SECOND import behind that
            // clock — a slow retry would then let the frame reject the promise
            // before the write ran, and the write would land anyway. Answer
            // now, leave the retry to a later request the artifact makes.
            onDispatchAbandoned(next, "unavailable");
            return;
          }
          try {
            next.frameWindow.postMessage(
              { type: DATA_DISPATCH_ACK_TYPE, requestId: next.request.requestId },
              "*"
            );
          } catch {
            // A gone frame still gets its request run; the response post is
            // what actually fails, and it fails the same way it always has.
          }
          await runBridgeRequest(next.request, next.frameWindow);
        })().finally(() => {
          inFlightDataRequestsRef.current -= 1;
          step();
        });
      }
    };
    step();
  }, [
    runBridgeRequest,
    inFlightDataRequestsRef,
    queuedDataRequestsRef,
    onDispatchAbandoned,
  ]);
}

/**
 * Answer a request the pump decided NOT to dispatch (#1788).
 *
 * Two cases, both of which must never reach the transport:
 *  - `timeout`: it waited past the parent's queue deadline, so the frame is
 *    about to give up (or already has).
 *  - `unavailable`: its transport chunk failed to load.
 *
 * Answering here rather than letting the frame's own clock expire keeps the
 * artifact's rejection prompt AND — the reason this exists — guarantees the
 * work is never started, so a `submit` cannot commit after its promise has
 * already been rejected.
 */
function useDispatchAbandonedHandler(
  reportDiagnostic: (
    request: ArtifactDataRequest,
    failure: ArtifactDataFailure
  ) => void
): (entry: QueuedBridgeRequest, code: ArtifactBridgeErrorCode) => void {
  return useCallback(
    (entry: QueuedBridgeRequest, code: ArtifactBridgeErrorCode) => {
      const failure = codedFailure(code);
      reportDiagnostic(entry.request, failure);
      try {
        entry.frameWindow.postMessage(
          dataBridgeFailure(entry.request.requestId, failure),
          "*"
        );
      } catch {
        // The frame is gone; there is nothing left to tell, and not starting
        // the work was the point.
      }
    },
    [reportDiagnostic]
  );
}

/**
 * Drop every queued entry that has waited past the parent's deadline (#1788).
 *
 * The frame gives up on a request it has been holding (its own pre-ack budget)
 * and deletes the pending entry; dispatching after that would run a real Server
 * Action whose answer nobody is waiting for — and for a `submit` that means a
 * write landing after the artifact was told it failed, so the author's retry
 * duplicates the record.
 *
 * Called from BOTH the pump and the admission check, which matters: a full
 * queue is refused before `pump()` ever runs, so purging only inside the pump
 * would let one never-settling request wedge the bridge permanently — every
 * later request answered `too_many_requests` behind entries that had long since
 * expired and would never be swept.
 *
 * Mutates the queue in place (it is a ref's array, shared with the pump).
 */
function purgeExpiredQueued(
  queue: QueuedBridgeRequest[],
  onDispatchAbandoned: (
    entry: QueuedBridgeRequest,
    code: ArtifactBridgeErrorCode
  ) => void
): void {
  const now = Date.now();
  while (queue.length > 0 && now - queue[0].enqueuedAt >= MAX_QUEUE_WAIT_MS) {
    const expired = queue.shift();
    if (expired) onDispatchAbandoned(expired, "timeout");
  }
}

/**
 * Drop anything still waiting when the bridge's mount goes away (#1788).
 *
 * The frame is torn down with it, so there is nobody left to answer; leaving
 * entries queued would let a late `pump()` from an in-flight completion dispatch
 * work for a version the canvas has already switched away from (#1787's
 * stale-diagnostic problem, one layer down).
 */
function useDrainQueueOnUnmount(
  queueRef: React.RefObject<QueuedBridgeRequest[]>
): void {
  useEffect(() => {
    const queue = queueRef.current;
    return () => {
      queue.length = 0;
    };
  }, [queueRef]);
}

/** Install the source-authenticated, bounded artifact data request listener. */
function useArtifactDataBridge({
  iframeRef,
  origin,
  dataBridgeEnabled,
  contentId,
  dataAccess,
  versionId,
  onDiagnostic,
}: ArtifactDataBridgeOptions): void {
  // False once this mount is torn down. The canvas remounts the sandbox (new
  // `key`) on every version switch, but a server action already in flight is not
  // cancelled by that — without this, a failure resolving after the switch would
  // be recorded as the NEW version's diagnostic (#1787).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const reportDiagnostic = useCallback(
    (
      request: { op?: unknown; sql?: unknown },
      failure: ArtifactDataFailure
    ): void => {
      if (!mountedRef.current) return;
      try {
        onDiagnostic?.({
          kind: "data",
          code: failure.code,
          message: failure.error,
          ...(request.op === "query" && typeof request.sql === "string"
            ? { sql: request.sql.slice(0, MAX_QUERY_SQL_LENGTH) }
            : {}),
        });
      } catch {
        // A broken consumer must never turn a data failure into a crash — the
        // frame is still owed its response.
      }
    },
    [onDiagnostic]
  );
  /** Requests currently dispatched (never more than the concurrency limit). */
  const inFlightDataRequestsRef = useRef(0);
  /** FIFO of accepted-but-not-yet-dispatched requests (#1788). */
  const queuedDataRequestsRef = useRef<QueuedBridgeRequest[]>([]);
  /**
   * #1712: pin the mode for the LIFETIME of this mount, not just to the current
   * prop. Nothing on the reader route re-renders this component with a fresher
   * `dataAccess` today (the mode is edited only on /atrium/[id]/edit, and the
   * reader never calls router.refresh), but if that ever changes — an RSC
   * refresh after the owner flipped `data_access`, say — it must not widen what
   * an ALREADY RUNNING artifact may do: that artifact still holds whatever it
   * queried under the old mode. Only a fresh mount, which starts with nothing
   * in memory, picks up a new mode. `useRef`'s initial value is captured on the
   * first render and never reassigned, so this is exactly "the mode at load".
   * The reader keys the component on the artifact id so a mount is always one
   * artifact.
   */
  const loadedDataAccessRef = useRef(dataAccess);

  /**
   * Execute one source-authenticated bridge request. `contentId` is constructed
   * exclusively from trusted props; request fields are copied individually, so
   * an artifact-supplied `contentId` (or any other extra field) cannot override
   * the authority boundary. Action failures and thrown errors collapse to the
   * same generic response.
   */
  const runBridgeRequest = useCallback(
    async (request: ArtifactDataRequest, frameWindow: Window): Promise<void> => {
      // `contentId` was proven present by `parentSideRefusal` before the request
      // was queued; repeating the check is what narrows it to a string here.
      if (!contentId) {
        const failure = codedFailure("unavailable");
        reportDiagnostic(request, failure);
        frameWindow.postMessage(dataBridgeFailure(request.requestId, failure), "*");
        return;
      }
      let response: ArtifactDataResponse;
      try {
        const outcome = await invokeBridgeAction(request, contentId, versionId);
        if (outcome.ok) {
          response = {
            type: "atrium-artifact-data-response",
            requestId: request.requestId,
            ok: true,
            data: outcome.data,
          };
        } else {
          reportDiagnostic(request, outcome.failure);
          response = dataBridgeFailure(request.requestId, outcome.failure);
        }
      } catch {
        // A thrown transport (offline, DNS, a torn-down page) never produced a
        // classified answer at all.
        const failure = codedFailure("unavailable");
        reportDiagnostic(request, failure);
        response = dataBridgeFailure(request.requestId, failure);
      }

      // The authenticated receiver is an opaque-origin WindowProxy. As with
      // postCode, a concrete targetOrigin would silently discard the response.
      frameWindow.postMessage(response, "*");
    },
    [contentId, reportDiagnostic, versionId]
  );

  const handleDispatchAbandoned = useDispatchAbandonedHandler(reportDiagnostic);

  const pump = useBridgePump(
    runBridgeRequest,
    inFlightDataRequestsRef,
    queuedDataRequestsRef,
    handleDispatchAbandoned
  );

  const handleDataRequest = useCallback(
    (request: ArtifactDataRequest, frameWindow: Window): void => {
      // Sweep expired entries BEFORE measuring capacity. A full queue is
      // refused below without ever reaching `pump()`, so purging only there
      // would let one never-settling request wedge the bridge: every later
      // request refused `too_many_requests` behind entries that had long since
      // expired and would never be swept (#1788).
      purgeExpiredQueued(queuedDataRequestsRef.current, handleDispatchAbandoned);
      const refusal = parentSideRefusal({
        dataBridgeEnabled,
        contentId,
        request,
        loadedDataAccess: loadedDataAccessRef.current,
        outstanding:
          inFlightDataRequestsRef.current + queuedDataRequestsRef.current.length,
      });
      if (refusal || !contentId) {
        // `!contentId` is already covered by `parentSideRefusal`; repeating it
        // here keeps this fail-closed if that gate ever changes.
        const failure = refusal ?? codedFailure("unavailable");
        reportDiagnostic(request, failure);
        frameWindow.postMessage(dataBridgeFailure(request.requestId, failure), "*");
        return;
      }
      queuedDataRequestsRef.current.push({
        request,
        frameWindow,
        enqueuedAt: Date.now(),
      });
      pump();
    },
    // `loadedDataAccessRef` is a stable ref, deliberately NOT a dependency: the
    // pinned mode must not change for the life of this mount (see the ref).
    [
      contentId,
      dataBridgeEnabled,
      pump,
      reportDiagnostic,
      handleDispatchAbandoned,
    ]
  );

  useDrainQueueOnUnmount(queuedDataRequestsRef);

  /**
   * Answer a request the narrowing predicate rejected (see
   * `malformedDataRequestId`). Nothing reaches a Server Action. A query gets
   * the same answer `parentSideRefusal` gives an out-of-bounds one — or
   * `not_query_mode` when the loaded mode forbids queries at all — and a
   * record op keeps its generic pre-#1787 failure.
   */
  const handleMalformedRequest = useCallback(
    (data: unknown, frameWindow: Window): void => {
      const requestId = malformedDataRequestId(data);
      if (!requestId) return;
      const request = data as { op?: unknown; sql?: unknown };
      let failure = RECORD_OP_FAILURE;
      if (dataBridgeEnabled && contentId && request.op === "query") {
        failure = isOpAllowedByLoadedMode("query", loadedDataAccessRef.current)
          ? MALFORMED_QUERY_FAILURE
          : codedFailure("not_query_mode");
      }
      reportDiagnostic(request, failure);
      frameWindow.postMessage(dataBridgeFailure(requestId, failure), "*");
    },
    // `loadedDataAccessRef` is a stable ref (see handleDataRequest).
    [contentId, dataBridgeEnabled, reportDiagnostic]
  );

  useEffect(() => {
    if (!origin) return;
    const onDataMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      // This browser-assigned WindowProxy identity is the bridge's sender
      // authentication. event.origin is intentionally not consulted: a real
      // `sandbox="allow-scripts"` frame has the opaque serialized origin "null".
      if (!frameWindow || event.source !== frameWindow) return;
      if (isArtifactDataRequest(event.data)) {
        handleDataRequest(event.data, frameWindow);
        return;
      }
      handleMalformedRequest(event.data, frameWindow);
    };
    window.addEventListener("message", onDataMessage);
    return () => window.removeEventListener("message", onDataMessage);
  }, [handleDataRequest, handleMalformedRequest, iframeRef, origin]);
}

/**
 * Collect the frame's own uncaught errors and unhandled rejections (#1787).
 *
 * `render.html` installs a `window.onerror` / `unhandledrejection` forwarder and
 * posts `{ type: "atrium-artifact-error", message }` to the parent. That is safe
 * in both directions: the message is PARENT-BOUND only (it cannot reach any
 * other window), and it carries nothing but a string the artifact's own code
 * produced.
 *
 * Without this, the most common authoring failure of all — a `ReferenceError` in
 * the artifact's bootstrap — is visible only in a browser console nobody has
 * open, least of all the model that wrote the code.
 *
 * Installed independently of the data bridge: a script error is worth reporting
 * on an artifact with no data access at all.
 */
function useArtifactFrameErrors(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  origin: string | null,
  onDiagnostic?: (diagnostic: ArtifactSandboxDiagnostic) => void
): void {
  useEffect(() => {
    if (!origin || !onDiagnostic) return;
    const onMessage = (event: MessageEvent) => {
      // Same WindowProxy-identity authentication as the data bridge: an opaque
      // origin reports "null", so `event.origin` cannot be the authenticator.
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isArtifactFrameError(event.data)) return;
      const message = boundBridgeErrorMessage(event.data.message);
      if (!message) return;
      try {
        onDiagnostic(frameErrorDiagnostic(event.data, message));
      } catch {
        // Never let a consumer's throw escape a message handler.
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // `onDiagnostic` is a dependency rather than a render-assigned ref (which
    // react-hooks/refs forbids): callers pass a `useCallback`-stable function,
    // so the listener is installed once. An unstable one only costs a
    // remove/add pair per render, never a missed message.
  }, [iframeRef, origin, onDiagnostic]);
}

/** Shared look for the two non-executable notices (unavailable / frame error). */
const sandboxNoticeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 160,
  border: "1px dashed var(--border, #d4d4d8)",
  borderRadius: 8,
  color: "#71717a",
  fontSize: 13,
  padding: 16,
  textAlign: "center",
};

export function ArtifactSandbox({
  code,
  src = null,
  title = "Artifact preview",
  className,
  dataBridgeEnabled = false,
  contentId,
  dataAccess,
  versionId,
  onDiagnostic,
}: ArtifactSandboxProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The render URL is resolved server-side and arrives via `src`. Derive the
  // bare sandbox origin from it (a pure, cheap computation — recomputing per
  // render also tracks a changed `src`, unlike a mount-frozen useState). This
  // origin is NOT used as the postMessage targetOrigin (the frame is opaque-origin
  // — see postCode), and inbound acks arrive with event.origin "null" for the
  // same reason (sender authentication is the event.source identity check in the
  // ack listener); it gates whether we post/listen at all (fail closed when
  // null). normalizeOrigin strips the `/render` path back to the bare origin and
  // returns null for a missing/invalid value (→ fail closed).
  const origin = normalizeOrigin(src);
  // Track whether the iframe load succeeded or failed (e.g. CSP blocked or
  // sandbox origin returned 404) so we can show a meaningful error notice.
  const [frameStatus, setFrameStatus] = useState<FrameLoadStatus>("loading");
  // Track the host's render acknowledgement so we can (a) stop re-posting once
  // the artifact is live and (b) surface an explicit error instead of leaving the
  // host stuck on "Waiting for artifact…" when a render never lands.
  const [renderStatus, setRenderStatus] = useState<RenderStatus>("pending");
  // A ref mirror of "the host has acked ok" that the retry interval reads without
  // being re-created on every render (the setInterval closure would otherwise see
  // a stale `renderStatus`).
  const renderedRef = useRef(false);
  useArtifactDataBridge({
    iframeRef,
    origin,
    dataBridgeEnabled,
    contentId,
    dataAccess,
    versionId,
    onDiagnostic,
  });
  useArtifactFrameErrors(iframeRef, origin, onDiagnostic);

  /**
   * Post the current code to the framed host. Reads `code` and `origin` via
   * closure; driven by the delivery effect (an immediate post plus a bounded
   * retry interval until the host acks) and re-posted when `onLoad` fires.
   *
   * SECURITY — why targetOrigin is "*" here and not the sandbox origin:
   * The frame is `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so the
   * framed document runs in an OPAQUE origin (it is NOT `origin`, even though it
   * was served from there). A `postMessage` whose targetOrigin is a concrete URL
   * is only delivered when the frame's document origin matches that URL exactly;
   * an opaque-origin document matches NO concrete origin, so a targeted post is
   * silently dropped and the artifact never renders (MDN: opaque/`data:`-origin
   * frames require `"*"`). We therefore post with `"*"` and rely on the HOST page
   * to authenticate the SENDER instead: render.html only acts on a message whose
   * `event.origin` is on its build-time parent-origin allowlist. The payload is
   * the untrusted artifact code itself — there is no app secret to leak via `"*"`,
   * and the cross-origin + sandbox + CSP layers remain the isolation boundary.
   * We still gate on `origin` (resolved from the configured sandbox URL) so an
   * unconfigured/same-origin sandbox posts nothing (fail closed).
   */
  const postCode = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame || !origin) return;
    frame.contentWindow?.postMessage({ type: "atrium-render", code }, "*");
  }, [code, origin]);

  // Listen for the host's render acknowledgement. We validate the event origin
  // strictly and ignore anything else. The ack carries only a boolean outcome
  // (never artifact data), so acting on it cannot be influenced by frame content
  // beyond "did the render succeed".
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      // The framed host runs in an OPAQUE origin (sandbox="allow-scripts" with
      // no allow-same-origin — see the file header), so a legitimate ack arrives
      // with event.origin === "null" (the opaque-origin serialization), NEVER the
      // configured sandbox origin. Rejecting "null" here would drop every real
      // ack and let the retry budget below misclassify perfectly rendered
      // artifacts as errors ~12s in. The configured origin is still accepted
      // defensively in case the host is ever served without the sandbox flags.
      if (event.origin !== "null" && event.origin !== origin) return;
      // Per-INSTANCE correlation AND the actual authentication: every sandbox on
      // the page shares the one configured origin (library thumbnails mount
      // several at once; a document can hold many embeds), and the host replies
      // to the shared top window — so origin alone would let the fastest
      // sibling's ack mark EVERY instance "rendered" and kill their retry loops
      // (blank frames, no error). Only the ack sent by OUR iframe's
      // contentWindow counts — event.source is browser-assigned and unforgeable,
      // which is what makes accepting "null"-origin messages safe. After unmount
      // the ref is null and late acks are ignored. (WindowProxy identity
      // comparison is legal cross-origin; no host/payload change needed.)
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isRenderAck(event.data)) return;
      if (event.data.ok) {
        renderedRef.current = true;
        // Monotonic pending→rendered: never resurrect an already-errored frame
        // (the error branch has unmounted the iframe; a stale flip to "rendered"
        // would strand a fresh, never-posted frame as permanently blank).
        setRenderStatus((prev) => (prev === "pending" ? "rendered" : prev));
      }
      // `ok: false` is NOT terminal: the host documents a transient failure mode
      // (an artifact script mutating the DOM out from under executeScripts), and
      // the very next re-post can succeed. Keep the retry loop running; a
      // persistently failing artifact exhausts RENDER_MAX_ATTEMPTS and surfaces
      // the explicit error notice below (bounded, ~12s).
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  // Drive code delivery: post immediately, then re-post on an interval until the
  // host acks (renderedRef) or the attempt budget is exhausted. This does NOT
  // depend on the iframe's `onLoad` — an SSR reader frame can finish loading
  // before hydration, so onLoad may never fire; posting on a timer (the frame's
  // contentWindow already exists and buffers nothing, but the host, once loaded,
  // acts on the next post) closes that race. Re-runs when the frame flips to
  // "loaded" (post again right after load) and short-circuits once rendered/errored.
  useEffect(() => {
    if (!origin) return; // fail closed: nothing posted without a sandbox origin
    if (frameStatus === "error") return; // the frame itself failed to load
    if (renderStatus !== "pending") return; // already rendered or errored out
    postCode(); // immediate attempt (covers the already-loaded SSR frame)
    let attempts = 0;
    const timer = setInterval(() => {
      if (renderedRef.current) {
        clearInterval(timer);
        return;
      }
      attempts += 1;
      if (attempts >= RENDER_MAX_ATTEMPTS) {
        clearInterval(timer);
        // Only escalate if still pending — a late ack could have resolved us.
        setRenderStatus((prev) => (prev === "pending" ? "error" : prev));
        return;
      }
      postCode();
    }, RENDER_RETRY_MS);
    return () => clearInterval(timer);
  }, [origin, frameStatus, renderStatus, postCode]);

  const handleLoad = useCallback(() => {
    // Marking the frame loaded re-runs the retry effect, which posts again right
    // after load; posting is idempotent on the host (it replaces its subtree).
    setFrameStatus("loaded");
  }, []);

  const handleError = useCallback(() => {
    setFrameStatus("error");
  }, []);

  // Fail closed: with no configured (separate) sandbox origin we render NOTHING
  // executable. We never fall back to rendering the untrusted code on the app
  // origin.
  if (!src) {
    return (
      <div
        className={className}
        role="status"
        data-testid="artifact-sandbox-unavailable"
        style={sandboxNoticeStyle}
      >
        Artifact preview is unavailable: the sandbox origin
        (<code>ATRIUM_SANDBOX_ORIGIN</code>) is not configured for this
        environment.
      </div>
    );
  }

  // Explicit failure surface (instead of an endless "Waiting for artifact…"):
  // either the iframe itself failed to load (`frameStatus`), or the host never
  // acknowledged a render within the retry budget / acked a render failure
  // (`renderStatus`).
  if (frameStatus === "error" || renderStatus === "error") {
    return (
      <div
        className={className}
        role="status"
        data-testid="artifact-sandbox-frame-error"
        style={sandboxNoticeStyle}
      >
        Artifact preview could not load. The sandbox host may be unreachable,
        blocked by the browser&apos;s content security policy, or the artifact
        took too long to render.
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={title}
      src={src}
      // SECURITY: allow-scripts ONLY. Never add allow-same-origin — together they
      // let framed code drop its own sandbox (see file header).
      sandbox="allow-scripts"
      // Empty Permissions-Policy for the frame: pin it to NO feature grants
      // regardless of what the parent page's Permissions-Policy allows (the app
      // grants microphone=(self) for voice mode — `allow=""` stops that, or any
      // future grant, from flowing into the untrusted artifact frame).
      allow=""
      referrerPolicy="no-referrer"
      onLoad={handleLoad}
      onError={handleError}
      data-testid="artifact-sandbox-frame"
      className={className}
      // Height is intentionally NOT set inline here: an inline min-height beats
      // the per-surface class rule, which is exactly what made every surface a
      // tiny 360px box. Each caller's className owns the height now
      // (.atrium-artifact-preview / -viewport / -reader-frame / .atrium-embed-frame
      // / .mer-artifact-thumb-frame). Keep only the frame reset here.
      style={{ width: "100%", border: 0, background: "#fff" }}
    />
  );
}

export default ArtifactSandbox;
