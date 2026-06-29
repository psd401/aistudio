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
 * - The artifact code is delivered by `postMessage` AFTER the frame loads, with
 *   an EXACT `targetOrigin` (never `"*"`) — code is never embedded in the iframe
 *   `src`, never serialized into app-origin HTML, and never passed to
 *   `dangerouslySetInnerHTML`.
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
import { getArtifactSandboxOrigin, getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";

export interface ArtifactSandboxProps {
  /**
   * The untrusted artifact code (HTML/JS). It is sent to the cross-origin host
   * via postMessage and never touches the app-origin DOM.
   */
  code: string;
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
  title = "Artifact preview",
  className,
}: ArtifactSandboxProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Resolve once on mount; the env-derived origin is stable for the page life.
  const [origin] = useState(() => getArtifactSandboxOrigin());
  const [src] = useState(() => getArtifactSandboxRenderUrl());
  // Whether the frame has loaded at least once (so a `code` change after load
  // re-posts without waiting for another `onLoad`, which fires only on navigation).
  const loadedRef = useRef(false);

  /**
   * Post the current code to the framed host with an EXACT target origin. Reads
   * `code` and `origin` via closure; callers re-invoke on load and on code change.
   */
  const postCode = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame || !origin) return;
    // targetOrigin is the resolved sandbox origin — NEVER "*". If the frame were
    // ever navigated elsewhere, the browser would refuse to deliver the message.
    frame.contentWindow?.postMessage({ type: "atrium-render", code }, origin);
  }, [code, origin]);

  // Re-post whenever the code changes (e.g. switching versions) AFTER the initial
  // load. The onLoad handler covers the first post; this covers subsequent edits
  // to the same mounted frame (onLoad does not re-fire without a navigation).
  useEffect(() => {
    if (loadedRef.current) postCode();
  }, [postCode]);

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
    loadedRef.current = true;
    postCode();
  }, [postCode]);

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

  return (
    <iframe
      ref={iframeRef}
      title={title}
      src={src}
      // SECURITY: allow-scripts ONLY. Never add allow-same-origin — together they
      // let framed code drop its own sandbox (see file header).
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={handleLoad}
      data-testid="artifact-sandbox-frame"
      className={className}
      style={{ width: "100%", minHeight: 360, border: 0, background: "#fff" }}
    />
  );
}

export default ArtifactSandbox;
