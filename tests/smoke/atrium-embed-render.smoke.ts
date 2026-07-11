/**
 * Atrium embedded-artifact render smoke test (Bun) — Epic #1059, slice D
 *
 * The reader (`/c/[slug]`, `/p/[slug]`) renders a document body by splitting it on
 * the `::atrium-artifact{id="…"}` leaf directive into ordered html + embed parts
 * (`renderDocumentToParts`), then resolving each embed on the artifact's own
 * visibility. This smoke covers the pure split + directive contract — the exact
 * segmentation the reader renders — including the safety edges (malformed id and a
 * directive inside a fenced code block must NOT split). The DB-gated visibility
 * masking is enforced by `resolveEmbedForReader` (shared canView gate).
 *
 * Uses the pure-ESM unified pipeline, so it is NOT a jest test.
 * Run: `bun run tests/smoke/atrium-embed-render.smoke.ts`
 */

import assert from "node:assert/strict";
import { renderDocumentToParts } from "@/lib/content/render/document-parts";
import {
  serializeArtifactEmbedDirective,
  parseArtifactEmbedAttrs,
  parseEmbeddedArtifactIds,
  isArtifactId,
} from "@/lib/content/embed-directive";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const UUID_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

check("a body with an embed splits into html · embed · html in order", () => {
  const md = `# Heading\n\nIntro paragraph.\n\n::atrium-artifact{id="${UUID_A}"}\n\nTrailing paragraph.`;
  const parts = renderDocumentToParts(md);
  assert.equal(parts.length, 3, `expected 3 parts, got ${parts.length}`);
  assert.equal(parts[0].kind, "html");
  assert.equal(parts[1].kind, "embed");
  assert.equal(parts[2].kind, "html");
  assert.equal(
    parts[1].kind === "embed" ? parts[1].artifactId : null,
    UUID_A,
    "embed part carries the artifact id"
  );
  // The surrounding html is sanitized document HTML (headings survive).
  assert.match(parts[0].kind === "html" ? parts[0].html : "", /<h1/);
  assert.match(parts[2].kind === "html" ? parts[2].html : "", /Trailing paragraph/);
});

check("a body with NO embed yields a single html part (unchanged render)", () => {
  const parts = renderDocumentToParts("# Title\n\nJust text, no embeds.");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, "html");
});

check("a malformed embed directive (bad id) stays ordinary text — not split", () => {
  const parts = renderDocumentToParts('before\n\n::atrium-artifact{id="not-a-uuid"}\n\nafter');
  assert.ok(
    parts.every((p) => p.kind === "html"),
    "no embed part produced for a malformed id"
  );
});

check("an embed directive INSIDE a fenced code block is NOT split", () => {
  const md = `Docs:\n\n\`\`\`\n::atrium-artifact{id="${UUID_A}"}\n\`\`\`\n\nafter`;
  const parts = renderDocumentToParts(md);
  assert.ok(
    parts.every((p) => p.kind === "html"),
    "a directive documented inside a code fence must not become a live embed"
  );
});

check("a fenced example directive creates NO backlink (render + backlinks agree)", () => {
  // The reader render (renderDocumentToParts) and the snapshot backlink parser
  // (parseEmbeddedArtifactIds) share ONE fence-aware recognizer, so a directive that
  // only documents the syntax inside a code fence is inert for BOTH — no live embed
  // AND no content_embed_links row.
  const md = `Docs:\n\n\`\`\`\n::atrium-artifact{id="${UUID_A}"}\n\`\`\`\n\nafter`;
  assert.deepEqual(
    parseEmbeddedArtifactIds(md),
    [],
    "a fenced example must not create a backlink"
  );
  const parts = renderDocumentToParts(md);
  assert.ok(parts.every((p) => p.kind === "html"), "fenced example must render inert");
});

check("a mismatched ~~~ inside an unclosed ``` does not resurrect a live embed", () => {
  // CommonMark: a ``` fence closes only on a ``` line — a ~~~ line does NOT close it,
  // and an unclosed fence runs to EOF. A naive any-fence toggle would treat the ~~~
  // as a close and then tokenize the following directive as a LIVE embed. It must not.
  const md = `\`\`\`\n~~~\n::atrium-artifact{id="${UUID_A}"}\nstill code`;
  const parts = renderDocumentToParts(md);
  assert.ok(
    parts.every((p) => p.kind === "html"),
    "a mismatched inner fence must not reopen the doc to a live embed"
  );
  assert.deepEqual(
    parseEmbeddedArtifactIds(md),
    [],
    "a directive inside an unclosed fence must not create a backlink"
  );
});

check("a real ``` close DOES re-enable a following embed", () => {
  // The counter-case: after a properly matched ``` close, a subsequent directive on
  // its own line IS a live embed again (the fence tracker must not stay stuck open).
  const md = `\`\`\`\ncode\n\`\`\`\n\n::atrium-artifact{id="${UUID_A}"}`;
  const parts = renderDocumentToParts(md);
  const kinds = parts.map((p) => p.kind);
  assert.ok(kinds.includes("embed"), "an embed after a closed fence must be live");
  assert.deepEqual(parseEmbeddedArtifactIds(md), [UUID_A]);
});

check("a directive TRAILING prose on the same line is inert (whole-line only)", () => {
  // The reader's whole-line recognizer requires the directive to own the entire line
  // (matches the editor tokenizer's line-anchoring fix). Prose + directive on one
  // line is one inert paragraph — never a live embed and never a backlink.
  const md = `see this ::atrium-artifact{id="${UUID_A}"} inline`;
  const parts = renderDocumentToParts(md);
  assert.ok(parts.every((p) => p.kind === "html"), "an inline directive must stay text");
  assert.deepEqual(parseEmbeddedArtifactIds(md), []);
});

check("two embeds around text produce html · embed · html · embed", () => {
  const md = `a\n\n::atrium-artifact{id="${UUID_A}"}\n\nb\n\n::atrium-artifact{id="${UUID_B}"}`;
  const parts = renderDocumentToParts(md);
  const kinds = parts.map((p) => p.kind);
  assert.deepEqual(kinds, ["html", "embed", "html", "embed"]);
});

check("serialize/parse of the directive round-trips the id (lowercased)", () => {
  const directive = serializeArtifactEmbedDirective(UUID_A);
  assert.equal(directive, `::atrium-artifact{id="${UUID_A}"}`);
  const line = directive!.match(/\{([^}]*)\}/)![1];
  assert.equal(parseArtifactEmbedAttrs(line), UUID_A);
  // A non-UUID never serializes (defensive — no malformed directive is emitted).
  assert.equal(serializeArtifactEmbedDirective("nope"), null);
  assert.equal(isArtifactId(UUID_A), true);
  assert.equal(isArtifactId("nope"), false);
});

check("parseEmbeddedArtifactIds dedupes and preserves first-seen order", () => {
  const md = `::atrium-artifact{id="${UUID_A}"}\n\ntext\n\n::atrium-artifact{id="${UUID_B}"}\n\n::atrium-artifact{id="${UUID_A}"}`;
  assert.deepEqual(parseEmbeddedArtifactIds(md), [UUID_A, UUID_B]);
});

// --- Meridian slice F: rich blocks render inside the reader's html parts --------
// The slice-F callout / image-grid / video blocks are NOT embeds — they ride inside
// the ordinary html runs `renderDocumentToParts` produces around each embed. This
// proves the reader's actual body-render path (the one both readers call), not just
// `renderMarkdownToHtml` in isolation, emits their allowlisted markup un-split.
check("slice-F rich blocks render inside the html parts around an embed", () => {
  const md = [
    ":::callout",
    "📣 **Heads up:** shuttle map below.",
    ":::",
    "",
    `::atrium-artifact{id="${UUID_A}"}`,
    "",
    ":::grid",
    "![a](https://cdn.example/a.png)",
    "![b](https://cdn.example/b.png)",
    ":::",
    "",
    '::video{src="https://cdn.example/clip.mp4"}',
  ].join("\n");
  const parts = renderDocumentToParts(md);
  const kinds = parts.map((p) => p.kind);
  assert.ok(kinds.includes("embed"), "the embed still splits out on its own");
  const html = parts
    .filter((p) => p.kind === "html")
    .map((p) => (p.kind === "html" ? p.html : ""))
    .join("\n");
  assert.match(html, /class="atrium-callout"/, "callout renders in an html part");
  assert.match(html, /class="atrium-image-grid"/, "image grid renders in an html part");
  assert.match(html, /<video[^>]*class="atrium-video"/, "video renders in an html part");
  assert.doesNotMatch(html, /javascript:/i, "no unsafe url survives the reader path");
});

console.log(`\natrium-embed-render smoke: ${passed} checks passed`);
