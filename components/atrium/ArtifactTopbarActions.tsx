"use client";

/**
 * Atrium artifact viewer topbar actions (Epic #1059 Meridian redesign, slice D)
 *
 * The two clipboard affordances in the artifact viewer topbar:
 *  - "Embed in doc" copies the canonical embed directive
 *    (`::atrium-artifact{id="…"}`) so it can be pasted into a document (the live
 *    insertion path is the editor's ✦ embed picker; this is the copy-snippet
 *    shortcut).
 *  - "Share" copies the artifact's reader URL for the current visibility
 *    (public → `/p/<slug>`, else the internal `/c/<slug>`), resolved to an absolute
 *    URL against the current origin.
 *
 * Both show a brief "Copied" confirmation. Client component (clipboard + state).
 */

import { useCallback, useState } from "react";
import { serializeArtifactEmbedDirective } from "@/lib/content/embed-directive";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "ArtifactTopbarActions" });

type Copied = "none" | "embed" | "share";

export interface ArtifactTopbarActionsProps {
  /** The artifact's content-object id (embedded via its directive). */
  artifactId: string;
  /** The reader path for the current visibility (e.g. "/c/slug" or "/p/slug"). */
  readerHref: string;
}

export function ArtifactTopbarActions({
  artifactId,
  readerHref,
}: ArtifactTopbarActionsProps): React.JSX.Element {
  const [copied, setCopied] = useState<Copied>("none");

  const copy = useCallback(async (text: string, which: Copied) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied("none"), 1600);
    } catch (e) {
      log.warn("clipboard write failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const directive = serializeArtifactEmbedDirective(artifactId) ?? "";
  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}${readerHref}` : readerHref;

  return (
    <>
      <button
        type="button"
        className="mer-ectl"
        data-testid="artifact-embed-in-doc"
        disabled={!directive}
        onClick={() => void copy(directive, "embed")}
        title="Copy the embed code to paste into a document"
      >
        {copied === "embed" ? "Copied ✓" : "Embed in doc"}
      </button>
      <button
        type="button"
        className="mer-ectl"
        data-testid="artifact-share"
        onClick={() => void copy(shareUrl, "share")}
        title="Copy a shareable reader link"
      >
        {copied === "share" ? "Link copied ✓" : "Share"}
      </button>
    </>
  );
}

export default ArtifactTopbarActions;
