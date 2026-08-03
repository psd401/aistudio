"use client";

/**
 * "Link" — the top section of the Share dialog.
 *
 * This replaces a topbar button that copied a URL to the clipboard and said
 * nothing else. That button was the fastest way to hand someone a dead link:
 * it always copied *a* URL, whether or not a publication existed behind it, and
 * whether or not the recipient could clear the object's visibility. The whole
 * point of showing the link here is to show it NEXT TO the two settings that
 * decide whether it works.
 *
 * The link shown is the one that actually resolves right now, in the same
 * precedence the readers use: a live public page, else the intranet page, else
 * the in-app viewer (which works for unpublished content and any viewer who can
 * already see it — so there is always something honest to hand over).
 */

import { useCallback, useState } from "react";
import { Check, Copy, Link2, AlertTriangle } from "lucide-react";
import { serializeArtifactEmbedDirective } from "@/lib/content/embed-directive";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "ShareLinkSection" });

export interface ShareLinkSectionProps {
  /** Content object id — the embed directive target. */
  objectId: string;
  /** Slug for the reader routes. */
  slug: string;
  kind: "document" | "artifact";
  /** A live `public_web` publication exists. */
  publicLive: boolean;
  /** A live `intranet` publication exists. */
  intranetLive: boolean;
  /** The object's SAVED visibility (a draft pick changes nothing yet). */
  savedLevel: "private" | "group" | "internal" | "public";
}

/** What the recipient of this link needs in order to open it. */
function audienceLine(
  target: "public" | "intranet" | "viewer",
  savedLevel: ShareLinkSectionProps["savedLevel"]
): string {
  if (target === "public") {
    return "Anyone with this link can open it — no sign-in required.";
  }
  if (target === "intranet") {
    return savedLevel === "internal" || savedLevel === "public"
      ? "Anyone signed in to AI Studio can open this link."
      : "Only the specific people you have shared it with can open this link.";
  }
  return "Only people who can already see this can open it. Publish it below to give it a page of its own.";
}

/**
 * Which reader route actually resolves for this object right now.
 *
 * Precedence mirrors the readers themselves: `/p` requires BOTH a live
 * `public_web` publication and public visibility; `/c` requires a live
 * `intranet` publication. The in-app viewer is the honest fallback — it is the
 * only one of the three that works for unpublished content, so there is always
 * a link that does something rather than a confident 404.
 */
function resolveShareTarget(input: {
  objectId: string;
  slug: string;
  publicLive: boolean;
  intranetLive: boolean;
  savedLevel: ShareLinkSectionProps["savedLevel"];
}): { target: "public" | "intranet" | "viewer"; path: string } {
  if (input.publicLive && input.savedLevel === "public") {
    return { target: "public", path: `/p/${input.slug}` };
  }
  if (input.intranetLive) {
    return { target: "intranet", path: `/c/${input.slug}` };
  }
  return { target: "viewer", path: `/atrium/${input.objectId}/view` };
}

export function ShareLinkSection({
  objectId,
  slug,
  kind,
  publicLive,
  intranetLive,
  savedLevel,
}: ShareLinkSectionProps): React.JSX.Element {
  const [copied, setCopied] = useState<"none" | "link" | "embed">("none");

  const copy = useCallback(async (text: string, which: "link" | "embed") => {
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

  const { target, path } = resolveShareTarget({
    objectId,
    slug,
    publicLive,
    intranetLive,
    savedLevel,
  });
  const url =
    typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  // A public publication that the public route will not serve. Surfaced right
  // on the link, because this is precisely the state where everything else in
  // the UI says "published" and the link 404s.
  const publicMismatch = publicLive && savedLevel !== "public";

  const directive =
    kind === "artifact" ? (serializeArtifactEmbedDirective(objectId) ?? "") : "";

  return (
    <div className="space-y-2">
      <p className="mer-share-section-label">
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> Link
      </p>
      <div className="mer-share-link-row">
        <code className="mer-share-link-url" data-testid="share-link-url">
          {url}
        </code>
        <button
          type="button"
          className="mer-btn"
          onClick={() => void copy(url, "link")}
          data-testid="share-copy-link"
        >
          {copied === "link" ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied === "link" ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mer-share-link-audience">{audienceLine(target, savedLevel)}</p>

      {publicMismatch && (
        <p className="mer-share-link-warning" role="status" data-testid="share-public-mismatch">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This is published to the public web, but its visibility is not Public,
          so the public address returns “not found”. Set the level to Public
          below, or unpublish it from the public web.
        </p>
      )}

      {kind === "artifact" && directive && (
        <button
          type="button"
          className="mer-share-embed"
          onClick={() => void copy(directive, "embed")}
          data-testid="share-copy-embed"
        >
          {copied === "embed" ? "Embed code copied ✓" : "Copy embed code for a document"}
        </button>
      )}
    </div>
  );
}

export default ShareLinkSection;
