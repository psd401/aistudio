/**
 * Atrium collab markdown<->Y.Doc bridge smoke test (Bun)
 *
 * Issue #1051. Verifies lib/content/collab/markdown-bridge.ts end to end: markdown
 * parses to ProseMirror JSON against the shared schema, authorship stamps onto
 * every text node, and a seeded Y.Doc round-trips back to JSON with content +
 * authorship intact. Uses the pure-ESM TipTap/Yjs stack, so it is NOT a jest test.
 *
 * Run: `bun run tests/smoke/atrium-collab-bridge.smoke.ts`
 */

import assert from "node:assert/strict";
import * as Y from "yjs";
import {
  markdownToProseMirrorJSON,
  stampAuthor,
  seedYDocFromMarkdown,
  yDocToProseMirrorJSON,
} from "@/lib/content/collab/markdown-bridge";
import { AUTHORED_MARK } from "@/lib/content/collab/provenance";
import { AtriumArtifactEmbed } from "@/lib/content/collab/artifact-embed-node";
import { serializeArtifactEmbedDirective } from "@/lib/content/embed-directive";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function collectText(node: unknown, out: string[] = []): string[] {
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") out.push(n.text);
  if (Array.isArray(n.content)) {
    for (const c of n.content) collectText(c, out);
  }
  return out;
}

function everyTextHasAuthor(node: unknown, by: string): boolean {
  const n = node as {
    type?: string;
    marks?: { type: string; attrs?: { by?: string } }[];
    content?: unknown[];
  };
  if (n.type === "text") {
    const mark = (n.marks ?? []).find((m) => m.type === AUTHORED_MARK);
    if (!mark || mark.attrs?.by !== by) return false;
  }
  if (Array.isArray(n.content)) return n.content.every((c) => everyTextHasAuthor(c, by));
  return true;
}

check("markdown parses to ProseMirror JSON (heading + paragraph)", () => {
  const json = markdownToProseMirrorJSON("# Title\n\nHello world");
  assert.equal((json as { type?: string }).type, "doc");
  const text = collectText(json).join(" ");
  assert.match(text, /Title/);
  assert.match(text, /Hello world/);
});

check("stampAuthor marks every text node with the author tag", () => {
  const json = stampAuthor(markdownToProseMirrorJSON("# Title\n\nbody"), "ai:bot-1");
  assert.ok(everyTextHasAuthor(json, "ai:bot-1"), "all text nodes carry ai:bot-1");
});

check("seedYDocFromMarkdown produces a non-empty Y.Doc", () => {
  const doc = seedYDocFromMarkdown("# Title\n\nbody text", "human:7");
  const update = Y.encodeStateAsUpdate(doc);
  assert.ok(update.byteLength > 0, "encoded state is non-empty");
});

check("seeded Y.Doc round-trips back to JSON with content + authorship", () => {
  const doc = seedYDocFromMarkdown("# Title\n\nhello bridge", "ai:bot-9");
  const json = yDocToProseMirrorJSON(doc);
  const text = collectText(json).join(" ");
  assert.match(text, /Title/);
  assert.match(text, /hello bridge/);
  assert.ok(everyTextHasAuthor(json, "ai:bot-9"), "authorship survives the round-trip");
});

// --- Adversarial markdown: the seeding path must NOT carry raw HTML into the doc.
// The ProseMirror schema is not a security boundary; markdownToProseMirrorJSON
// drops raw HTML at the `marked` layer (editorMarked renderer.html -> ""). These
// assert that no script/event-handler/embedding vector survives into the seeded
// ProseMirror tree. (Regression guard for PR #1062 review finding #1.)
function jsonContainsString(node: unknown, needle: string): boolean {
  const s = JSON.stringify(node).toLowerCase();
  return s.includes(needle.toLowerCase());
}

check("raw <script> in markdown is dropped from the seeded doc", () => {
  const json = markdownToProseMirrorJSON("intro\n\n<script>alert(1)</script>\n\nend");
  assert.ok(!jsonContainsString(json, "<script"), "no <script tag survives");
  assert.ok(!jsonContainsString(json, "alert(1)"), "no script body survives");
  const text = collectText(json).join(" ");
  assert.match(text, /intro/);
  assert.match(text, /end/);
});

check("inline <img onerror> is dropped, surrounding text preserved", () => {
  const json = markdownToProseMirrorJSON('before <img src=x onerror="alert(1)"> after');
  assert.ok(!jsonContainsString(json, "onerror"), "no onerror handler survives");
  assert.ok(!jsonContainsString(json, "<img"), "no <img tag survives");
  const text = collectText(json).join(" ");
  assert.match(text, /before/);
  assert.match(text, /after/);
});

check("raw <iframe>/<div onclick> embedding markup is dropped", () => {
  const json = markdownToProseMirrorJSON(
    "# Heading\n\n<iframe src=evil></iframe>\n\n<div onclick=\"x\">nope</div>"
  );
  assert.ok(!jsonContainsString(json, "<iframe"), "no <iframe tag survives");
  assert.ok(!jsonContainsString(json, "onclick"), "no onclick handler survives");
  assert.match(collectText(json).join(" "), /Heading/);
});

check("legitimate markdown formatting still parses (no over-stripping)", () => {
  const json = markdownToProseMirrorJSON("normal **bold** and _em_ text");
  const text = collectText(json).join(" ");
  assert.match(text, /bold/);
  assert.match(text, /em/);
});

// --- Meridian slice D: embedded-artifact directive round-trip -----------------
// markdown → node : the marked seed extension recognizes the leaf directive and
// generateJSON parses it into the atriumArtifactEmbed node (carrying the id).
// node → markdown : the node's tiptap-markdown serializer re-emits that directive.
const EMBED_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function findNodes(node: unknown, type: string, out: unknown[] = []): unknown[] {
  const n = node as { type?: string; content?: unknown[] };
  if (n.type === type) out.push(n);
  if (Array.isArray(n.content)) for (const c of n.content) findNodes(c, type, out);
  return out;
}

check("embed directive in markdown seeds an atriumArtifactEmbed node", () => {
  const json = markdownToProseMirrorJSON(
    `intro paragraph\n\n::atrium-artifact{id="${EMBED_UUID}"}\n\ntrailing text`
  );
  const embeds = findNodes(json, "atriumArtifactEmbed") as Array<{
    attrs?: { artifactId?: string };
  }>;
  assert.equal(embeds.length, 1, "exactly one embed node parsed");
  assert.equal(embeds[0].attrs?.artifactId, EMBED_UUID, "embed carries the artifact id");
  // Surrounding blocks survive (the directive is a clean block boundary).
  const text = collectText(json).join(" ");
  assert.match(text, /intro paragraph/);
  assert.match(text, /trailing text/);
});

check("a malformed embed directive (bad id) is NOT parsed as an embed", () => {
  const json = markdownToProseMirrorJSON('::atrium-artifact{id="not-a-uuid"}');
  const embeds = findNodes(json, "atriumArtifactEmbed");
  assert.equal(embeds.length, 0, "invalid id falls through, no embed node");
});

check("a directive TRAILING prose on the same line is NOT a live embed (line-anchored)", () => {
  // Fix (P2): the editor tokenizer must require the directive to occupy its OWN whole
  // line — matching the reader's whole-line ARTIFACT_EMBED_LINE_RE. A directive that
  // trails other prose on the same line must stay inert text in the editor too, or the
  // editor would show a live embed the reader renders as plain text (a desync). The
  // preceding-prose text must survive as content.
  const json = markdownToProseMirrorJSON(`see this ::atrium-artifact{id="${EMBED_UUID}"} inline`);
  const embeds = findNodes(json, "atriumArtifactEmbed");
  assert.equal(embeds.length, 0, "an inline (non-line-anchored) directive is not an embed");
  const text = collectText(json).join(" ");
  assert.match(text, /see this/, "surrounding prose is preserved as text");
});

check("the embed node serializes back to its canonical directive line", () => {
  // Invoke the node's tiptap-markdown serializer directly (a headless editor is
  // not constructible in Bun without a DOM); the serializer is pure over a
  // MarkdownSerializerState stub.
  const cfg = (
    AtriumArtifactEmbed as unknown as {
      config: { addStorage?: () => { markdown: { serialize: (s: unknown, n: unknown) => void } } };
    }
  ).config;
  const storage = cfg.addStorage?.();
  assert.ok(storage, "embed node exposes a markdown storage spec");
  let out = "";
  const state = { write: (s: string) => { out += s; }, closeBlock: () => {} };
  storage!.markdown.serialize(state, { attrs: { artifactId: EMBED_UUID } });
  assert.equal(out, serializeArtifactEmbedDirective(EMBED_UUID));
  assert.match(out, /^::atrium-artifact\{id="[0-9a-f-]+"\}$/);
});

console.log(`\natrium-collab-bridge smoke: ${passed} checks passed`);
