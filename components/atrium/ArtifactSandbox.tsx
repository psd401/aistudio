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

export interface ArtifactSandboxProps {
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

interface RenderAck {
  type: "atrium-artifact-rendered";
  ok: boolean;
  error?: string;
}

/** Narrow an unknown postMessage payload to the host's render acknowledgement. */
function isRenderAck(data: unknown): data is RenderAck {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "atrium-artifact-rendered"
  );
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
