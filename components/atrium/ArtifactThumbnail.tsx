"use client";

/**
 * Atrium library artifact thumbnail (Epic #1059 Meridian slice F, upgrades slice B)
 *
 * A live, scaled preview of an artifact on its library card (README §"1b" artifact
 * card, "real sandboxed thumbnails … scaled iframe"). It reuses the EXACT
 * cross-origin sandbox contract (`ArtifactSandbox`): `allow-scripts` only (never
 * `allow-same-origin`), code delivered by postMessage, fail-closed when the sandbox
 * origin is unconfigured — nothing about the isolation boundary changes here. It is
 * only shrunk (CSS transform), made non-interactive (`pointer-events:none`), and:
 *
 *  - LAZY: the frame is not mounted until the card scrolls near the viewport
 *    (IntersectionObserver), so an offscreen artifact costs nothing.
 *  - CAPPED: a module-level counter bounds how many live frames exist at once
 *    (`FRAME_CAP`); past the cap a card keeps the gradient placeholder. The slot is
 *    released on unmount (e.g. when the filter re-renders the grid).
 *  - GRACEFUL: the branded gradient (slice B) is the pre-load AND fallback state —
 *    shown before the frame mounts, when the sandbox origin is unavailable, or when
 *    the code fetch fails. A viewer never sees a broken frame.
 */

import { useEffect, useRef, useState } from "react";
import { getArtifactCodeAction } from "@/actions/db/atrium/get-artifact-code";
import { ArtifactSandbox } from "./ArtifactSandbox";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "ArtifactThumbnail" });

/** Max simultaneously-mounted preview iframes across the whole library grid. */
const FRAME_CAP = 4;
let liveFrames = 0;

type ThumbState = "idle" | "loading" | "ready" | "fallback";

export interface ArtifactThumbnailProps {
  artifactId: string;
  /**
   * The sandbox render URL resolved SERVER-SIDE (`getArtifactSandboxRenderUrl()`)
   * and passed down. `null` → the sandbox origin is unconfigured, so we never
   * attempt a live frame and stay on the gradient (fail closed, like ArtifactSandbox).
   */
  sandboxSrc: string | null;
}

export function ArtifactThumbnail({
  artifactId,
  sandboxSrc,
}: ArtifactThumbnailProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const claimedRef = useRef(false);
  const [state, setState] = useState<ThumbState>("idle");
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    // No sandbox origin → never mount a frame; the gradient is the whole preview.
    if (!sandboxSrc) return;
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting || claimedRef.current) return;
        // Respect the concurrent-frame cap: past it, stay on the gradient.
        if (liveFrames >= FRAME_CAP) return;
        liveFrames += 1;
        claimedRef.current = true;
        observer.disconnect();
        setState("loading");
        void getArtifactCodeAction(artifactId)
          .then((res) => {
            if (cancelled) return;
            if (res.isSuccess && res.data.code) {
              setCode(res.data.code);
              setState("ready");
            } else {
              // Release the slot on a failed load so another card can claim it.
              liveFrames -= 1;
              claimedRef.current = false;
              setState("fallback");
              log.warn("thumbnail code load failed", {
                artifactId,
                message: res.isSuccess ? "empty code" : res.message,
              });
            }
          })
          .catch((e) => {
            if (cancelled) return;
            liveFrames -= 1;
            claimedRef.current = false;
            setState("fallback");
            log.error("thumbnail code load threw", {
              artifactId,
              error: e instanceof Error ? e.message : String(e),
            });
          });
      },
      // Preload just before the card enters the viewport.
      { rootMargin: "150px" }
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      // Free the slot when the card unmounts (filter change / navigation).
      if (claimedRef.current) {
        liveFrames -= 1;
        claimedRef.current = false;
      }
    };
  }, [artifactId, sandboxSrc]);

  return (
    <div ref={ref} className="mer-artifact-preview" aria-hidden="true">
      <span className="mer-badge mer-badge-live">● Live artifact</span>
      {state === "ready" && code && sandboxSrc ? (
        <div className="mer-artifact-thumb-scale">
          <ArtifactSandbox
            code={code}
            src={sandboxSrc}
            title="Artifact preview"
            className="mer-artifact-thumb-frame"
          />
        </div>
      ) : null}
    </div>
  );
}

export default ArtifactThumbnail;
