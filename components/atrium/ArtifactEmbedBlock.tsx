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
 */

import { ArtifactSandbox } from "./ArtifactSandbox";

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
}

export function ArtifactEmbedBlock({
  available,
  title,
  code,
  sandboxSrc,
  href,
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
      <ArtifactSandbox code={code} src={sandboxSrc} className="atrium-embed-frame" />
    </div>
  );
}

export default ArtifactEmbedBlock;
