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

console.log(`\natrium-collab-bridge smoke: ${passed} checks passed`);
