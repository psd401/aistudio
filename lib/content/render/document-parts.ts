/**
 * Atrium document render — split into html + embedded-artifact parts (slice D)
 *
 * The readers (`/c/[slug]`, `/p/[slug]`) render a document by interleaving
 * sanitized-HTML runs with LIVE embedded-artifact blocks. A document body can't be
 * one `dangerouslySetInnerHTML` string anymore, because an embedded artifact must
 * render as a cross-origin `<ArtifactSandbox>` (a React/client component), gated on
 * the ARTIFACT's own visibility for the current viewer.
 *
 * This module does the SPLIT only (pure, server-safe): it scans the canonical
 * markdown for the embed leaf directive (`lib/content/embed-directive.ts`) at block
 * level and returns an ordered list of parts. Each non-embed run is rendered to
 * sanitized HTML through the SAME `renderMarkdownToHtml` pipeline the whole document
 * used before, so nothing about document typography/sanitization changes; a document
 * with no embeds yields a single html part identical to the old single-render path.
 *
 * The reader resolves each `embed` part server-side (visibility + code) and renders
 * it as a quiet placeholder when the viewer may not see the artifact — see
 * `embed-resolver.ts`. The split never loads or leaks artifact content itself.
 */

import { renderMarkdownToHtml } from "./markdown-render";
import { scanMarkdownEmbedLines } from "../embed-directive";

/** One rendered segment of a document body. */
export type DocumentPart =
  | { kind: "html"; html: string }
  | { kind: "embed"; artifactId: string };

/**
 * Split a document's canonical markdown into ordered html + embed parts.
 *
 * A real embed is the leaf directive `::atrium-artifact{id="<uuid>"}` on its own
 * line at block level (never inside a fenced code block). The fence-aware line
 * classification is the SHARED `scanMarkdownEmbedLines` — the exact same recognizer
 * the backlink parser (`parseEmbeddedArtifactIds`) uses — so the reader render and
 * the persisted `content_embed_links` backlinks always agree on what is an embed
 * (CommonMark fence rules, incl. an unmatched fence that stays open to EOF).
 * Malformed directives (bad/absent id) fall through as ordinary text, so they
 * render harmlessly rather than silently vanishing.
 */
export function renderDocumentToParts(markdown: string): DocumentPart[] {
  if (!markdown) return [];
  const parts: DocumentPart[] = [];
  const buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const html = renderMarkdownToHtml(buffer.join("\n"));
    if (html) parts.push({ kind: "html", html });
    buffer.length = 0;
  };

  scanMarkdownEmbedLines(markdown, (line, embedId) => {
    if (embedId) {
      flush();
      parts.push({ kind: "embed", artifactId: embedId });
    } else {
      buffer.push(line);
    }
  });
  flush();
  return parts;
}
