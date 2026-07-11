"use client";

/**
 * Atrium embedded-artifact NodeView (Epic #1059 Meridian redesign, slice D)
 *
 * The live editor rendering of the `atriumArtifactEmbed` node. TipTap attaches this
 * React NodeView CLIENT-side (DocumentEditor `.extend({ addNodeView })`), so the
 * shared schema module stays React-free and the server/collab bundle never pulls in
 * the sandbox component (see `artifact-embed-node.ts`).
 *
 * On mount it resolves the referenced artifact via `resolveArtifactEmbedAction`
 * (visibility-gated: a non-viewable artifact resolves to an unavailable
 * placeholder, never leaking title/code) and renders the shared
 * `<ArtifactEmbedBlock>` — the same Meridian bordered block the readers render.
 * The node is an ATOM, so the wrapper is non-editable and drag-enabled.
 */

import { useEffect, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { resolveArtifactEmbedAction } from "@/actions/db/atrium/resolve-artifact-embed";
import type { ResolvedEmbed } from "@/lib/content/embed-resolver";
import { createLogger } from "@/lib/client-logger";
import { ArtifactEmbedBlock } from "./ArtifactEmbedBlock";

const log = createLogger({ component: "ArtifactEmbedNodeView" });

/** The masked result used for a missing id or a failed/denied resolve. */
function maskedEmbed(artifactId: string): ResolvedEmbed {
  return { artifactId, available: false, title: null, href: null, code: "", sandboxSrc: null };
}

export function ArtifactEmbedNodeView(props: ReactNodeViewProps): React.JSX.Element {
  const artifactId =
    typeof props.node.attrs.artifactId === "string" ? props.node.attrs.artifactId : "";
  const cachedTitle =
    typeof props.node.attrs.title === "string" ? props.node.attrs.title : null;

  const [resolved, setResolved] = useState<ResolvedEmbed | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!artifactId) {
      setResolved(maskedEmbed(artifactId));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await resolveArtifactEmbedAction(artifactId);
        if (cancelled) return;
        setResolved(res.isSuccess ? res.data : maskedEmbed(artifactId));
      } catch (e) {
        if (cancelled) return;
        log.warn("resolveArtifactEmbedAction threw", {
          error: e instanceof Error ? e.message : String(e),
        });
        setResolved(maskedEmbed(artifactId));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  return (
    <NodeViewWrapper
      className="atrium-embed-nodeview"
      contentEditable={false}
      data-drag-handle
      data-testid="artifact-embed-nodeview"
    >
      {loading || !resolved ? (
        <div
          className="atrium-embed atrium-embed-loading"
          data-testid="artifact-embed-loading"
        >
          <span className="atrium-embed-mark" aria-hidden="true">
            ✦
          </span>{" "}
          {cachedTitle ?? "Loading embedded artifact…"}
        </div>
      ) : (
        <ArtifactEmbedBlock
          available={resolved.available}
          title={resolved.title ?? cachedTitle}
          code={resolved.code}
          sandboxSrc={resolved.sandboxSrc}
          href={resolved.href}
        />
      )}
    </NodeViewWrapper>
  );
}

export default ArtifactEmbedNodeView;
