/**
 * Atrium reader document body (Epic #1059 Meridian redesign, slice D)
 *
 * Server component that renders a document body as ordered parts: sanitized-HTML
 * runs (`dangerouslySetInnerHTML`, the SAME sink as before) interleaved with live
 * embedded-artifact blocks. Both the internal (`/c/[slug]`) and public
 * (`/p/[slug]`) readers render through this so the embed behavior is identical.
 *
 * Every embed is resolved server-side by `resolveDocumentParts` (visibility-gated
 * per viewer) BEFORE this renders — a non-viewable artifact arrives as an
 * `available: false` placeholder, so no artifact content is ever loaded or leaked
 * here. `.atrium-content` stays the single body sink (typography + test anchor);
 * its selectors are descendant, so wrapping each HTML run in a div is transparent.
 */

import type { RenderedDocumentPart } from "@/lib/content/embed-resolver";
import { ArtifactEmbedBlock } from "./ArtifactEmbedBlock";

export function ReaderDocumentBody({
  parts,
}: {
  parts: RenderedDocumentPart[];
}): React.JSX.Element {
  return (
    <article className="atrium-content" data-testid="reader-body">
      {parts.map((part, i) =>
        part.kind === "html" ? (
          <div
            // Parts are positional and stable for a given render; the index key is
            // appropriate (the list is never reordered or filtered client-side).
            key={`html-${i}`}
            className="atrium-content-html"
            dangerouslySetInnerHTML={{ __html: part.html }}
          />
        ) : (
          <ArtifactEmbedBlock
            key={`embed-${i}`}
            available={part.embed.available}
            title={part.embed.title}
            code={part.embed.code}
            sandboxSrc={part.embed.sandboxSrc}
            href={part.embed.href}
          />
        )
      )}
    </article>
  );
}

export default ReaderDocumentBody;
