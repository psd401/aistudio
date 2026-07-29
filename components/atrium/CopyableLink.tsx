"use client";

/**
 * Atrium CopyableLink — a reader URL the author can actually take away (#1336).
 *
 * Used by the publish success caption (C3) and the VisibilityChip public-link
 * notice (C1). Before #1336 the public URL was computed by the `public_web`
 * adapter, persisted to `content_publications.external_ref`, and then never
 * shown anywhere — so people shared `/atrium/[id]/edit` or `/c/{slug}` and their
 * audience hit a sign-in wall.
 *
 * The link itself is a plain anchor (works with middle-click, right-click →
 * copy, and keyboard) with a copy button beside it. The clipboard write is
 * best-effort: `navigator.clipboard` is unavailable on insecure origins and can
 * be permission-denied, in which case the anchor is still the fallback.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "CopyableLink" });

/** How long the "Copied" confirmation stays up. */
const COPIED_MS = 1600;

export function CopyableLink({
  url,
  testId,
}: {
  url: string;
  /** `data-testid` for the anchor, so E2E can assert the exact URL. */
  testId?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  // Reset the confirmation on a timer, cancelled on unmount / URL change so a
  // late fire cannot set state on an unmounted component.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch (e) {
      // Insecure origin or denied permission — the anchor remains the fallback.
      log.warn("clipboard write failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [url]);

  return (
    <span className="mer-copy-link">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mer-copy-link-url"
        data-testid={testId}
      >
        {url}
      </a>
      <button
        type="button"
        className="mer-copy-link-btn"
        onClick={() => void copy()}
        aria-label={copied ? "Link copied" : "Copy link"}
        title={copied ? "Copied" : "Copy link"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
