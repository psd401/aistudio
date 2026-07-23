"use client";

/**
 * Atrium reader "ON THIS PAGE" table of contents (Epic #1059, slice E)
 *
 * The left-rail TOC on the published reader (screen 2c). Headings are extracted
 * SERVER-side (`lib/content/render/headings.ts`) with ids that match the `id`
 * attributes rehype-slug writes onto the rendered `<h1..h3>`, so each entry is a
 * plain in-page `#slug` anchor — no client-side heading parsing.
 *
 * The only client behavior is scroll-spy: an IntersectionObserver highlights the
 * heading currently near the top of the viewport (brand-colored, 2px left rule).
 * It degrades gracefully — with JS off, the anchors still navigate and the first
 * item shows as active. Returns null when the document has no h1–h3 headings (e.g.
 * artifact readers pass an empty list to skip the TOC entirely).
 */

import { useEffect, useState } from "react";
import type { DocumentHeading } from "@/lib/content/render/headings";

export function ReaderToc({
  headings,
}: {
  headings: DocumentHeading[];
}): React.JSX.Element | null {
  const [activeId, setActiveId] = useState<string | null>(
    headings[0]?.id ?? null
  );

  useEffect(() => {
    if (headings.length === 0) return;
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Of the headings currently crossing the top band of the viewport, the
        // highest one is "active". Ignore callbacks with nothing intersecting so the
        // last active item stays highlighted while scrolling between headings.
        const intersecting = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          );
        if (intersecting.length > 0) {
          setActiveId(intersecting[0]!.target.id);
        }
      },
      // Trigger when a heading enters the band just below the sticky nav; the large
      // negative bottom margin keeps only the top-most in-view heading active.
      { rootMargin: "-84px 0px -70% 0px", threshold: 0 }
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <div data-testid="reader-toc">
      <div className="mer-reader-toc-label">On this page</div>
      <nav className="mer-reader-toc" aria-label="On this page">
        {headings.map((h) => (
          <a
            key={h.id}
            href={`#${h.id}`}
            className="mer-reader-toc-link"
            data-depth={h.depth}
            data-active={activeId === h.id ? "true" : "false"}
            onClick={() => setActiveId(h.id)}
          >
            {h.text}
          </a>
        ))}
      </nav>
    </div>
  );
}

export default ReaderToc;
