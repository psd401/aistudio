/**
 * Atrium markdown render pipeline smoke test (Bun)
 *
 * Issue #1051. Verifies lib/content/render/markdown-render.ts end to end. The
 * pipeline imports the pure-ESM unified/remark/rehype ecosystem, which next/jest
 * (SWC) cannot transform in node_modules — so it is NOT a jest unit test. Bun
 * executes ESM + TS natively, so we assert the real pipeline here.
 *
 * Run: `bun run tests/smoke/atrium-markdown-render.smoke.ts`
 * Exits non-zero on the first failed assertion.
 */

import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "@/lib/content/render/markdown-render";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

check("renders headings and bold", () => {
  const html = renderMarkdownToHtml("# Hello\n\n**bold**");
  // rehype-slug adds a stable, github-slugger id to every heading (the reader TOC
  // anchors to it). The id is generated from the heading text — never raw author
  // input — so it opens no injection surface despite running after sanitize.
  assert.match(html, /<h1 id="hello">Hello<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

check("heading ids are github-slugged + de-duplicated", () => {
  const html = renderMarkdownToHtml("## Parade & closures\n\n## Parade & closures");
  // Non-word chars collapse to hyphens; a duplicate heading gets a `-1` suffix.
  assert.match(html, /<h2 id="parade--closures">/);
  assert.match(html, /<h2 id="parade--closures-1">/);
});

check("strips <script> authored in markdown", () => {
  const html = renderMarkdownToHtml("text\n\n<script>evil()</script>");
  assert.doesNotMatch(html, /<script/i);
});

check("drops raw embedded HTML (allowDangerousHtml=false)", () => {
  const html = renderMarkdownToHtml("a <b onmouseover='x'>z</b> c");
  assert.doesNotMatch(html, /onmouseover/i);
  assert.doesNotMatch(html, /<b\b/i);
});

check("renders GFM strikethrough + table", () => {
  assert.match(renderMarkdownToHtml("~~gone~~"), /<del>gone<\/del>/);
  const table = renderMarkdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.match(table, /<table>/);
  assert.match(table, /<td>1<\/td>/);
});

check(":::callout -> allowlisted div class", () => {
  const html = renderMarkdownToHtml(":::callout\nHeads up\n:::");
  assert.match(html, /<div class="atrium-callout"/);
  assert.match(html, /Heads up/);
});

check(":::warn -> warn modifier class", () => {
  const html = renderMarkdownToHtml(":::warn\nDanger\n:::");
  assert.match(html, /class="atrium-callout atrium-callout-warn"/);
});

check("unknown directive emits no tag from its name", () => {
  const html = renderMarkdownToHtml(":::script\nx\n:::");
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /x/);
});

check("math renders via KaTeX after the sanitize gate", () => {
  const html = renderMarkdownToHtml("$E=mc^2$");
  assert.match(html, /class="katex/);
});

check("strips data: URI from img src (no XSS via image)", () => {
  const html = renderMarkdownToHtml(
    '![](data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">)'
  );
  assert.doesNotMatch(html, /data:image/i);
  assert.doesNotMatch(html, /onload/i);
});

check("strips javascript: URI from img src", () => {
  const html = renderMarkdownToHtml("![alt](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/i);
});

check("strips javascript: URI from link href", () => {
  const html = renderMarkdownToHtml("[link](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/i);
});

check("preserves https: img src", () => {
  const html = renderMarkdownToHtml("![ok](https://example.com/x.png)");
  assert.match(html, /src="https:\/\/example\.com\/x\.png"/);
});

check("empty input -> empty string", () => {
  assert.equal(renderMarkdownToHtml(""), "");
});

// --- Meridian slice F: image grid + video reader render -----------------------

check(":::grid -> image-grid div with allowlisted class + imgs", () => {
  const html = renderMarkdownToHtml(
    ":::grid\n![a](https://cdn.example/a.png)\n![b](https://cdn.example/b.png)\n:::"
  );
  assert.match(html, /class="atrium-image-grid"/, "grid container class survives sanitize");
  assert.match(html, /src="https:\/\/cdn\.example\/a\.png"/);
  assert.match(html, /src="https:\/\/cdn\.example\/b\.png"/);
});

check("::video{src} -> allowlisted <video> player", () => {
  const html = renderMarkdownToHtml('::video{src="https://cdn.example/clip.mp4"}');
  assert.match(html, /<video[^>]*class="atrium-video"/, "video tag + class survive sanitize");
  assert.match(html, /src="https:\/\/cdn\.example\/clip\.mp4"/);
  assert.match(html, /controls/, "native controls are kept");
});

check("a video with a javascript: src is stripped (no player)", () => {
  const html = renderMarkdownToHtml('::video{src="javascript:alert(1)"}');
  // The remark transform leaves the node inert (no <video> emitted) when the src is
  // unsafe, and the sanitizer's http/https `src` protocol pin is the backstop.
  assert.doesNotMatch(html, /javascript:/i, "no unsafe url in the output");
});

check("no <video> autoplay is ever emitted (published pages never auto-play)", () => {
  const html = renderMarkdownToHtml('::video{src="https://cdn.example/clip.mp4"}');
  assert.doesNotMatch(html, /autoplay/i, "autoplay is not an allowed attribute");
});

console.log(`\natrium-markdown-render smoke: ${passed} checks passed`);
