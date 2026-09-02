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
 *   callers explicitly enable the bridge, work is bounded per frame, and every
 *   failure returned to artifact code uses the same generic message. Responses
 *   also require `targetOrigin: "*"` because the receiving frame is opaque-origin.
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
/** Keep a hostile artifact from queueing unbounded server-action work. */
const MAX_IN_FLIGHT_DATA_REQUESTS = 8;
const MAX_DATA_PAYLOAD_BYTES = 8 * 1024;
const MAX_DATA_PAYLOAD_VALUES = 8_192;
const MAX_DATA_PAYLOAD_STRING_CODE_UNITS = MAX_DATA_PAYLOAD_BYTES;
/** One response for every bridge failure; never expose action or database detail. */
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
      }
    | { dataBridgeEnabled?: false; contentId?: never; dataAccess?: never }
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
  | {
      type: "atrium-artifact-data-response";
      requestId: string;
      ok: false;
      error: string;
    };

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

function dataBridgeFailure(requestId: string): ArtifactDataResponse {
  return {
    type: "atrium-artifact-data-response",
    requestId,
    ok: false,
    error: DATA_BRIDGE_ERROR_MESSAGE,
  };
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

/** Sentinel for "the action ran and refused" — distinct from a thrown error. */
const BRIDGE_ACTION_FAILED = Symbol("atrium-bridge-action-failed");

/**
 * Route one validated request to its Server Action, copying ONLY the fields the
 * op is allowed to influence. `contentId` always comes from the trusted prop.
 *
 * The dynamic imports keep the server-only action graph out of fail-closed and
 * preview-only clients: Next resolves these `use server` modules to action
 * references only when an enabled bridge request reaches the authenticated
 * parent. The record actions and the query action are imported separately so a
 * records-only artifact never pulls in the data-connector action reference.
 */
async function invokeBridgeAction(
  request: ArtifactDataRequest,
  contentId: string
): Promise<unknown> {
  if (request.op === "query") {
    const { queryArtifactData } = await import(
      "@/actions/db/atrium/artifact-query"
    );
    const result = await queryArtifactData({
      contentId,
      sql: request.sql,
      limit: request.limit,
      offset: request.offset,
    });
    return result.isSuccess ? result.data : BRIDGE_ACTION_FAILED;
  }

  const { listArtifactRecords, submitArtifactRecord } = await import(
    "@/actions/db/atrium/artifact-data"
  );
  if (request.op === "submit") {
    const result = await submitArtifactRecord({
      contentId,
      namespace: request.namespace,
      payload: request.payload,
    });
    return result.isSuccess ? result.data : BRIDGE_ACTION_FAILED;
  }
  const result = await listArtifactRecords({
    contentId,
    namespace: request.namespace,
    limit: request.limit,
    scope: request.scope,
  });
  return result.isSuccess ? result.data : BRIDGE_ACTION_FAILED;
}

interface ArtifactDataBridgeOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  origin: string | null;
  dataBridgeEnabled: boolean;
  contentId?: string;
  /** The artifact's data-access mode as of THIS page load (#1712). */
  dataAccess?: ContentDataAccess;
}

/** Install the source-authenticated, bounded artifact data request listener. */
function useArtifactDataBridge({
  iframeRef,
  origin,
  dataBridgeEnabled,
  contentId,
  dataAccess,
}: ArtifactDataBridgeOptions): void {
  const inFlightDataRequestsRef = useRef(0);
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
  const handleDataRequest = useCallback(
    async (request: ArtifactDataRequest, frameWindow: Window): Promise<void> => {
      if (
        !dataBridgeEnabled ||
        !contentId ||
        // The mode this page was LOADED with (#1712) — checked before the
        // action so a mode flipped under an open page cannot be used by it.
        !isOpAllowedByLoadedMode(request.op, loadedDataAccessRef.current) ||
        !isRequestWithinBridgeBounds(request) ||
        inFlightDataRequestsRef.current >= MAX_IN_FLIGHT_DATA_REQUESTS
      ) {
        frameWindow.postMessage(dataBridgeFailure(request.requestId), "*");
        return;
      }

      inFlightDataRequestsRef.current += 1;
      let response: ArtifactDataResponse;
      try {
        const data = await invokeBridgeAction(request, contentId);
        response =
          data === BRIDGE_ACTION_FAILED
            ? dataBridgeFailure(request.requestId)
            : {
                type: "atrium-artifact-data-response",
                requestId: request.requestId,
                ok: true,
                data,
              };
      } catch {
        response = dataBridgeFailure(request.requestId);
      } finally {
        inFlightDataRequestsRef.current -= 1;
      }

      // The authenticated receiver is an opaque-origin WindowProxy. As with
      // postCode, a concrete targetOrigin would silently discard the response.
      frameWindow.postMessage(response, "*");
    },
    // `loadedDataAccessRef` is a stable ref, deliberately NOT a dependency: the
    // pinned mode must not change for the life of this mount (see the ref).
    [contentId, dataBridgeEnabled]
  );

  useEffect(() => {
    if (!origin) return;
    const onDataMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      // This browser-assigned WindowProxy identity is the bridge's sender
      // authentication. event.origin is intentionally not consulted: a real
      // `sandbox="allow-scripts"` frame has the opaque serialized origin "null".
      if (!frameWindow || event.source !== frameWindow) return;
      if (!isArtifactDataRequest(event.data)) return;
      void handleDataRequest(event.data, frameWindow);
    };
    window.addEventListener("message", onDataMessage);
    return () => window.removeEventListener("message", onDataMessage);
  }, [handleDataRequest, iframeRef, origin]);
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
  });

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
