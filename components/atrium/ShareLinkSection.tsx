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
 * Since #1726 those two settings are Live/Draft and the Level, and the links are
 * DERIVED from them rather than from a separate destination choice:
 *  - Draft            → the in-app viewer, which works for anyone who can already
 *                       see the object (so there is always an honest link).
 *  - Live             → `/c/{slug}`, the reader page.
 *  - Live AND Public  → additionally `/p/{slug}`, the anonymous page.
 *
 * Because the public address is derived from the same two values the reader
 * checks, the #1336 mismatch states (Public with no publication, published-to-web
 * without Public) cannot be represented at all — there is no second switch left
 * to disagree with the first.
 */

import { useCallback, useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { serializeArtifactEmbedDirective } from "@/lib/content/embed-directive";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "ShareLinkSection" });

export interface ShareLinkSectionProps {
  /** Content object id — the embed directive target. */
  objectId: string;
  /** Slug for the reader routes. */
  slug: string;
  kind: "document" | "artifact";
  /** The object has a live publication (#1726: one Live state, not a destination). */
  isLive: boolean;
  /** The object's SAVED visibility (a draft pick changes nothing yet). */
  savedLevel: "private" | "group" | "internal" | "public";
}

/** What the recipient of this link needs in order to open it. */
function audienceLine(
  target: "intranet" | "viewer",
  savedLevel: ShareLinkSectionProps["savedLevel"]
): string {
  if (target === "intranet") {
    if (savedLevel === "public") {
      return "Anyone signed in to AI Studio can open this link, and the public address below opens for anyone.";
    }
    return savedLevel === "internal"
      ? "Anyone signed in to AI Studio can open this link."
      : "Only the specific people you have shared it with can open this link.";
  }
  return "Only people who can already see this can open it. Publish it below to give it a page of its own.";
}

/**
 * The CANONICAL link for this object right now — the one to hand a colleague.
 *
 * A Live object has a reader page; a Draft has only the in-app viewer, which is
 * the honest fallback (it is the one link that works for unpublished content, so
 * there is always something to copy rather than a confident 404). The PUBLIC
 * address is shown separately rather than replacing this one: an object that is
 * Live and Public has both, and the internal link is still the right thing to
 * paste into a district channel.
 */
function resolveShareTarget(input: {
  objectId: string;
  slug: string;
  isLive: boolean;
}): { target: "intranet" | "viewer"; path: string } {
  if (input.isLive) {
    return { target: "intranet", path: `/c/${input.slug}` };
  }
  return { target: "viewer", path: `/atrium/${input.objectId}/view` };
}

export function ShareLinkSection({
  objectId,
  slug,
  kind,
  isLive,
  savedLevel,
}: ShareLinkSectionProps): React.JSX.Element {
  const [copied, setCopied] = useState<"none" | "link" | "public" | "embed">(
    "none"
  );

  const copy = useCallback(
    async (text: string, which: "link" | "public" | "embed") => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(which);
        window.setTimeout(() => setCopied("none"), 1600);
      } catch (e) {
        log.warn("clipboard write failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    []
  );

  const { target, path } = resolveShareTarget({ objectId, slug, isLive });
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}${path}`;

  // The public address, derived from exactly what `/p/[slug]` checks: Live AND
  // Public. There is no third state to warn about any more.
  const publicUrl =
    isLive && savedLevel === "public" ? `${origin}/p/${slug}` : null;

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

      {publicUrl && (
        <div className="mer-share-link-row" data-testid="share-public-link">
          <code className="mer-share-link-url" data-testid="share-public-link-url">
            {publicUrl}
          </code>
          <button
            type="button"
            className="mer-btn"
            onClick={() => void copy(publicUrl, "public")}
            data-testid="share-copy-public-link"
          >
            {copied === "public" ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copied === "public" ? "Copied" : "Copy"}
          </button>
        </div>
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
