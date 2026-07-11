/**
 * Atrium document-heading extractor smoke test (Bun)
 *
 * Epic #1059 (slice E). Verifies `lib/content/render/headings.ts` — the source of
 * the reader "ON THIS PAGE" TOC. Like the render pipeline it imports the pure-ESM
 * remark ecosystem, so it is NOT jest-loadable; Bun runs ESM + TS natively.
 *
 * The load-bearing invariant: the TOC ids must EQUAL the `id` attributes rehype-slug
 * writes onto the rendered `<h1..h3>` — otherwise a TOC anchor jumps nowhere. So the
 * key checks render the SAME markdown through `renderMarkdownToHtml` and assert the
 * extractor's ids match the DOM ids exactly (incl. de-duplication and embed splits).
 *
 * Run: `bun run tests/smoke/atrium-doc-headings.smoke.ts`
 */

import assert from "node:assert/strict";
import { extractDocumentHeadings } from "@/lib/content/render/headings";
import { renderDocumentToParts } from "@/lib/content/render/document-parts";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * The heading ids in the ACTUAL reader DOM, in document order. The reader renders a
 * body via `renderDocumentToParts` (one `renderMarkdownToHtml` call — hence one
 * rehype-slug slugger — per non-embed run), so this walks those html parts. That is
 * the exact rendering the extractor must agree with (including the per-embed slugger
 * reset), NOT a single whole-document render.
 */
function domHeadingIds(markdown: string): string[] {
  return renderDocumentToParts(markdown)
    .filter((p): p is { kind: "html"; html: string } => p.kind === "html")
    .flatMap((p) => [...p.html.matchAll(/<h[1-3] id="([^"]+)"/g)].map((m) => m[1]!));
}

check("extracts h1–h3 with text + depth", () => {
  const toc = extractDocumentHeadings("# Title\n\n## Section\n\n### Sub");
  assert.deepEqual(
    toc.map((h) => `${h.depth}:${h.text}`),
    ["1:Title", "2:Section", "3:Sub"]
  );
});

check("ids match the rendered DOM ids (incl. duplicate de-dup)", () => {
  const md = "# Homecoming Week\n\n## Schedule\n\n## Parade & closures\n\n## Schedule";
  const toc = extractDocumentHeadings(md);
  assert.deepEqual(
    toc.map((h) => h.id),
    ["homecoming-week", "schedule", "parade--closures", "schedule-1"]
  );
  // The anchor targets must exist in the rendered HTML, in the same order.
  assert.deepEqual(toc.map((h) => h.id), domHeadingIds(md));
});

check("excludes h4–h6 but still advances the slugger for them", () => {
  // The h4 "Schedule" consumes the base slug, so the later h2 "Schedule" is
  // de-duped to `schedule-1` — matching rehype-slug, which slugs every heading.
  const md = "## Schedule\n\n#### Schedule\n\n## Schedule";
  const toc = extractDocumentHeadings(md);
  assert.deepEqual(
    toc.map((h) => `${h.depth}:${h.id}`),
    ["2:schedule", "2:schedule-2"]
  );
  // Rendered DOM (h2s only match /h[1-3]/) shows the same de-dup for the visible ones.
  assert.deepEqual(toc.map((h) => h.id), domHeadingIds(md));
});

check("splits on an embedded-artifact directive (fresh slugger per run)", () => {
  // A duplicate heading text separated by an embed resets the slugger (each run is
  // an independent renderMarkdownToHtml call), so BOTH keep the base slug — exactly
  // as the split rendered DOM does.
  const md =
    "## Overview\n\n::atrium-artifact{id=\"a7100000-0000-4000-8000-000000004040\"}\n\n## Overview";
  const toc = extractDocumentHeadings(md);
  assert.deepEqual(
    toc.map((h) => h.id),
    ["overview", "overview"]
  );
  assert.deepEqual(toc.map((h) => h.id), domHeadingIds(md));
});

check("empty / heading-less input -> empty list", () => {
  assert.deepEqual(extractDocumentHeadings(""), []);
  assert.deepEqual(extractDocumentHeadings("just a paragraph, no headings"), []);
});

console.log(`\natrium-doc-headings smoke: ${passed} checks passed`);
