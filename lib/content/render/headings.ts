/**
 * Atrium document heading extraction — the reader "ON THIS PAGE" TOC source
 *
 * Epic #1059 (Meridian redesign, slice E). The reader (`/c/[slug]`, `/p/[slug]`)
 * renders a left-rail "ON THIS PAGE" table of contents built from the document's
 * own headings. This module produces that ordered heading list, server-side, with
 * ids that EXACTLY match the `id` attributes `rehype-slug` writes onto the rendered
 * `<h1..h3>` in `markdown-render.ts` — so each TOC entry anchors to the right
 * heading and in-page `#slug` links resolve.
 *
 * ## Why the ids match by construction
 * `renderMarkdownToHtml` runs `rehype-slug`, which instantiates a FRESH
 * `github-slugger` per call and slugs each heading's text in document order.
 * `renderDocumentToParts` calls `renderMarkdownToHtml` once per non-embed run (the
 * document is split around embedded-artifact directives). This extractor mirrors
 * that split with the SAME `scanMarkdownEmbedLines` recognizer and, per run, uses a
 * FRESH `github-slugger` over the SAME heading text (`mdast-util-to-string`) in the
 * SAME order — so the slugger's de-duplication (`foo`, `foo-1`, …) lands
 * identically to the rendered DOM ids, run for run.
 *
 * The slugger is advanced for EVERY heading (depths 1–6) even though only depths
 * 1–3 are surfaced in the TOC, so a deeper heading between two same-text headings
 * still shifts the de-dupe suffix exactly as rehype-slug does.
 *
 * ## Jest note
 * Like `markdown-render.ts`, this imports the pure-ESM unified/remark ecosystem,
 * which `next/jest` (SWC) cannot transform in node_modules. It is therefore NOT
 * jest-loadable; unit tests that transitively reach it (the reader pages) mock it,
 * and it is verified by tests/smoke/atrium-doc-headings.smoke.ts under Bun.
 */

import GithubSlugger from "github-slugger";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { toString as mdastToString } from "mdast-util-to-string";
import type { Root, Heading } from "mdast";
import { scanMarkdownEmbedLines } from "../embed-directive";

/** One rendered-document heading surfaced in the reader TOC. */
export interface DocumentHeading {
  /** The heading level (1–3; deeper headings are excluded from the TOC). */
  depth: number;
  /** The plain-text heading label. */
  text: string;
  /** The slug id — matches the `id` rehype-slug writes onto the rendered heading. */
  id: string;
}

/** Only h1–h3 surface in the TOC (deeper headings are too granular for a rail). */
const MIN_TOC_DEPTH = 1;
const MAX_TOC_DEPTH = 3;

// Parse-only processor (no transforms needed to read headings). remark-gfm is
// `.use()`d so its parser extensions match the render pipeline; freezing lets the
// parser be reused across runs without re-attaching.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/**
 * Extract the h1–h3 headings from a single non-embed markdown run with a fresh
 * slugger (mirrors one `renderMarkdownToHtml` call, so ids align with the DOM).
 */
function headingsForRun(run: string): DocumentHeading[] {
  const tree = parser.parse(run) as Root;
  const slugger = new GithubSlugger();
  const out: DocumentHeading[] = [];
  visit(tree, "heading", (node: Heading) => {
    const text = mdastToString(node).trim();
    // Slug EVERY heading (even depths > 3, even empty ones would consume a slug)
    // so de-duplication tracks rehype-slug exactly; only push the TOC-visible ones.
    const id = slugger.slug(text);
    if (text && node.depth >= MIN_TOC_DEPTH && node.depth <= MAX_TOC_DEPTH) {
      out.push({ depth: node.depth, text, id });
    }
  });
  return out;
}

/**
 * Build the ordered TOC heading list for a document's canonical markdown. Splits
 * on embedded-artifact directives exactly as the render pipeline does (fresh
 * slugger per run) so the returned ids match the rendered heading ids. Returns an
 * empty list for empty input or a document with no h1–h3 headings.
 */
export function extractDocumentHeadings(markdown: string): DocumentHeading[] {
  if (!markdown) return [];
  const headings: DocumentHeading[] = [];
  const buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    headings.push(...headingsForRun(buffer.join("\n")));
    buffer.length = 0;
  };

  // An embed line ends the current run (fresh slugger next run), matching how
  // renderDocumentToParts flushes an html part at each embed.
  scanMarkdownEmbedLines(markdown, (line, embedId) => {
    if (embedId) flush();
    else buffer.push(line);
  });
  flush();
  return headings;
}
