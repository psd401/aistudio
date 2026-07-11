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

console.log(`\natrium-embed-render smoke: ${passed} checks passed`);
