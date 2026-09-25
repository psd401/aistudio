"use client";

/**
 * Atrium embedded-artifact block (Epic #1059 Meridian redesign, slice D)
 *
 * The Meridian bordered block that renders an embedded artifact inside a document:
 * a light header ("✦ <title> — embedded artifact · Expand ↗") over the live,
 * cross-origin `<ArtifactSandbox>`. Purely presentational — every caller resolves
 * the artifact (visibility + code) BEFORE mounting this:
 *  - the readers (`/c/[slug]`, `/p/[slug]`) resolve server-side and pass props.
 *  - the editor NodeView (`ArtifactEmbedNodeView`) resolves via a server action.
 *
 * When `available` is false (the artifact does not exist or the viewer may not see
 * it) it renders a quiet, content-free placeholder — the existence mask; it never
 * receives code for a non-viewable artifact (see `embed-resolver.ts`).
 *
 * ## Data bridge (#1790)
 * `dataBridge` is the resolver's decision, forwarded — never this component's.
 * The resolver populates it only for the `internal` audience, after running the
 * same 404-masking `canView` the bridge's server actions repeat; the anonymous
 * `/p/<slug>` reader always resolves it to `null`. Omitting it (the default) is
 * fail-closed: the sandbox is then mounted with no bridge props at all, so a
 * caller that forgets to thread it degrades to the pre-#1790 behavior rather
 * than to an open bridge.
 */

import { ArtifactSandbox } from "./ArtifactSandbox";
import type { ResolvedEmbedDataBridge } from "@/lib/content/embed-resolver";

export interface ArtifactEmbedBlockProps {
  /** True only when the viewer may see the artifact (resolved upstream). */
  available: boolean;
  /** The artifact title for the header (only meaningful when available). */
  title: string | null;
  /** UNTRUSTED artifact code — handed to the cross-origin sandbox only. */
  code: string;
  /** The cross-origin sandbox render URL (null → sandbox fails closed). */
  sandboxSrc: string | null;
  /** The artifact reader route for the "Expand ↗" link, or null. */
  href: string | null;
  /**
   * Bridge wiring resolved upstream for an AUTHENTICATED embed (#1790), or
   * null/absent to mount the sandbox with no bridge at all.
   */
  dataBridge?: ResolvedEmbedDataBridge | null;
}

export function ArtifactEmbedBlock({
  available,
  title,
  code,
  sandboxSrc,
  href,
  dataBridge = null,
}: ArtifactEmbedBlockProps): React.JSX.Element {
  if (!available) {
    return (
      <div
        className="atrium-embed atrium-embed-unavailable"
        data-testid="artifact-embed-unavailable"
      >
        <span className="atrium-embed-unavailable-mark" aria-hidden="true">
          ⊘
        </span>
        This embedded artifact is unavailable or you don&apos;t have access to it.
      </div>
    );
  }
  return (
    <div className="atrium-embed" data-testid="artifact-embed">
      <div className="atrium-embed-head">
        <span className="atrium-embed-head-title">
          <span className="atrium-embed-mark" aria-hidden="true">
            ✦
          </span>{" "}
          {title ?? "Artifact"}
          <span className="atrium-embed-head-label"> — embedded artifact</span>
        </span>
        {href && (
          <a
            className="atrium-embed-expand"
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid="artifact-embed-expand"
          >
            Expand ↗
          </a>
        )}
      </div>
      {dataBridge ? (
        <ArtifactSandbox
          // #1712: the loaded-mode pin lives in a ref for the mount's lifetime,
          // so a mount must belong to exactly one artifact. The editor NodeView
          // can re-resolve a different artifact into the SAME block without
          // remounting it; keying on the content id makes the fresh mount
          // structural rather than incidental (same as /c and /view).
          key={dataBridge.contentId}
          code={code}
          src={sandboxSrc}
          className="atrium-embed-frame"
          dataBridgeEnabled
          contentId={dataBridge.contentId}
          dataAccess={dataBridge.dataAccess}
          versionId={dataBridge.versionId}
        />
      ) : (
        <ArtifactSandbox code={code} src={sandboxSrc} className="atrium-embed-frame" />
      )}
    </div>
  );
}

export default ArtifactEmbedBlock;
