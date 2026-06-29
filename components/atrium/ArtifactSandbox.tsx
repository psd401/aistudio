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

export function ArtifactSandbox({
  code,
  src = null,
  title = "Artifact preview",
  className,
}: ArtifactSandboxProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The render URL is resolved server-side and arrives via `src`. Derive the
  // bare sandbox origin from it once on mount (stable for the frame's life). This
  // origin is NOT used as the postMessage targetOrigin (the frame is opaque-origin
  // — see postCode); it gates whether we post at all (fail closed when null) and
  // is the strict allowlist for the inbound render-ack listener. normalizeOrigin
  // strips the `/render` path back to the bare origin and returns null for a
  // missing/invalid value (→ fail closed).
  const [origin] = useState(() => normalizeOrigin(src));
  // Track whether the iframe load succeeded or failed (e.g. CSP blocked or
  // sandbox origin returned 404) so we can show a meaningful error notice.
  const [frameStatus, setFrameStatus] = useState<FrameLoadStatus>("loading");

  /**
   * Post the current code to the framed host. Reads `code` and `origin` via
   * closure; invoked once by `handleLoad` after the frame's `onLoad` fires.
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

  // Optional: listen for the host's render acknowledgement for observability /
  // future error surfacing. We validate the event origin strictly and ignore
  // anything else; we do not act on the payload beyond bookkeeping so a forged
  // message cannot influence app behavior.
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return; // strict origin check
      if (!isRenderAck(event.data)) return;
      // Intentionally no state mutation from frame content; reserved for future
      // non-trust-bearing telemetry. Kept minimal to avoid trusting frame input.
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const handleLoad = useCallback(() => {
    setFrameStatus("loaded");
    postCode();
  }, [postCode]);

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
        style={{
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
        }}
      >
        Artifact preview is unavailable: the sandbox origin
        (<code>ATRIUM_SANDBOX_ORIGIN</code>) is not configured for this
        environment.
      </div>
    );
  }

  if (frameStatus === "error") {
    return (
      <div
        className={className}
        role="status"
        data-testid="artifact-sandbox-frame-error"
        style={{
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
        }}
      >
        Artifact preview could not load. The sandbox host may be unreachable or
        blocked by the browser&apos;s content security policy.
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
      style={{ width: "100%", minHeight: 360, border: 0, background: "#fff" }}
    />
  );
}

export default ArtifactSandbox;
