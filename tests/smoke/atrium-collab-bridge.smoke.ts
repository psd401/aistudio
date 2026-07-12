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
  trimBoundaryEmptyParagraphs,
} from "@/lib/content/collab/markdown-bridge";
import type { JSONContent } from "@tiptap/core";
import { AUTHORED_MARK } from "@/lib/content/collab/provenance";
import { AtriumArtifactEmbed } from "@/lib/content/collab/artifact-embed-node";
import { serializeArtifactEmbedDirective } from "@/lib/content/embed-directive";
import { AtriumCallout } from "@/lib/content/collab/callout-node";
import { AtriumVideo } from "@/lib/content/collab/media-nodes";

/** Invoke a node's tiptap-markdown serializer headlessly (no DOM). */
function serializeNode(
  node: unknown,
  attrs: Record<string, unknown>,
  children = ""
): string {
  const cfg = (
    node as unknown as {
      config: {
        addStorage?: () => {
          markdown: { serialize: (s: unknown, n: unknown) => void };
        };
      };
    }
  ).config;
  const storage = cfg.addStorage?.();
  if (!storage) throw new Error("node exposes no markdown storage spec");
  let out = "";
  const state = {
    write: (s: string) => {
      out += s;
    },
    renderContent: () => {
      out += children;
    },
    ensureNewLine: () => {
      if (!out.endsWith("\n")) out += "\n";
    },
    closeBlock: () => {},
  };
  storage.markdown.serialize(state, { attrs, childCount: 0 });
  return out;
}

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

// --- Meridian slice F: rich-block directive round-trip ------------------------
// markdown → node : the marked container/leaf extensions rewrite the directives to
// DOM and generateJSON parses them into the callout / grid / image / video nodes.
// node → markdown : each node's tiptap-markdown serializer re-emits the directive.

check(":::callout container seeds an atriumCallout node (variant note)", () => {
  const json = markdownToProseMirrorJSON(
    "intro\n\n:::callout\n📣 **Families:** street closures start at 4 PM.\n:::\n\nafter"
  );
  const callouts = findNodes(json, "atriumCallout") as Array<{
    attrs?: { variant?: string };
  }>;
  assert.equal(callouts.length, 1, "one callout node parsed");
  assert.equal(callouts[0].attrs?.variant, "note", "note variant");
  const text = collectText(json).join(" ");
  assert.match(text, /Families/, "callout inner text survives");
  assert.match(text, /intro/);
  assert.match(text, /after/);
});

check(":::warn container seeds a callout with variant warn", () => {
  const json = markdownToProseMirrorJSON(":::warn\nBe careful.\n:::");
  const callouts = findNodes(json, "atriumCallout") as Array<{
    attrs?: { variant?: string };
  }>;
  assert.equal(callouts.length, 1, "one callout node parsed");
  assert.equal(callouts[0].attrs?.variant, "warn", "warn variant");
});

check(":::grid seeds an image grid of atriumImage children", () => {
  const json = markdownToProseMirrorJSON(
    ":::grid\n![parade](https://cdn.example/a.png)\n![rally](https://cdn.example/b.png)\n:::"
  );
  const grids = findNodes(json, "atriumImageGrid");
  assert.equal(grids.length, 1, "one grid node parsed");
  const imgs = findNodes(json, "atriumImage") as Array<{ attrs?: { src?: string } }>;
  assert.equal(imgs.length, 2, "two image children parsed");
  assert.equal(imgs[0].attrs?.src, "https://cdn.example/a.png");
});

check("::video{src} seeds an atriumVideo node with the src", () => {
  const json = markdownToProseMirrorJSON('::video{src="https://cdn.example/clip.mp4"}');
  const videos = findNodes(json, "atriumVideo") as Array<{ attrs?: { src?: string } }>;
  assert.equal(videos.length, 1, "one video node parsed");
  assert.equal(videos[0].attrs?.src, "https://cdn.example/clip.mp4");
});

check("a video directive with an unsafe (javascript:) src is NOT seeded", () => {
  const json = markdownToProseMirrorJSON('::video{src="javascript:alert(1)"}');
  const videos = findNodes(json, "atriumVideo");
  // The directive falls through to inert paragraph TEXT (like a malformed embed) —
  // no video NODE is created, so the unsafe url never becomes a rendered src
  // attribute. It survives only as harmless characters in a text node.
  assert.equal(videos.length, 0, "unsafe src falls through, no video node");
  assert.ok(!jsonContainsString(json, "<video"), "no <video> element with the unsafe src");
});

check("callout / video nodes serialize back to their canonical directives", () => {
  const callout = serializeNode(AtriumCallout, { variant: "warn" }, "Be careful.\n");
  assert.match(callout, /^:::warn\n[\s\S]*\n:::$/, "warn callout round-trips");
  const note = serializeNode(AtriumCallout, { variant: "note" }, "note body\n");
  assert.match(note, /^:::callout\n/, "note callout uses :::callout");

  const video = serializeNode(AtriumVideo, { src: "https://cdn.example/clip.mp4" });
  assert.equal(video, '::video{src="https://cdn.example/clip.mp4"}');

  const badVideo = serializeNode(AtriumVideo, { src: "javascript:alert(1)" });
  assert.equal(badVideo, "", "an unsafe src serializes to nothing, not a directive");
});

// ---------------------------------------------------------------------------
// Editor vertical-spacing regression (Epic #1059 follow-up)
//
// A freshly-created Atrium doc is a single empty ProseMirror paragraph. The agent
// append path (`applyAgentEdit` append mode) merges the agent's blocks AFTER the
// doc's current content — a naive merge strands `[emptyParagraph, ...agentBlocks]`,
// which renders as ~1 dead line + block margins between the title/byline and the
// agent's first heading. `trimBoundaryEmptyParagraphs` removes the boundary empties
// before the merge. These checks pin that behavior.
// ---------------------------------------------------------------------------

const emptyPara: JSONContent = { type: "paragraph" };
const emptyParaWithBlankChildren: JSONContent = { type: "paragraph", content: [] };
const heading = (t: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text: t }],
});
const para = (t: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text: t }],
});

check("markdownToProseMirrorJSON emits NO empty-paragraph nodes for multi-section markdown", () => {
  const json = markdownToProseMirrorJSON(
    "## Background\n\nText one.\n\n## Goals\n\n- a\n- b\n\n## Timeline\n\nText two.\n"
  );
  const empties = (json.content ?? []).filter(
    (n) => n.type === "paragraph" && (!Array.isArray(n.content) || n.content.length === 0)
  );
  assert.equal(empties.length, 0, "no empty paragraphs from clean markdown");
});

check("trimBoundaryEmptyParagraphs on a BLANK doc ([emptyParagraph]) yields []", () => {
  assert.deepEqual(trimBoundaryEmptyParagraphs([emptyPara]), []);
  assert.deepEqual(trimBoundaryEmptyParagraphs([emptyParaWithBlankChildren]), []);
});

check("append-onto-blank leaves NO leading empty paragraph after trimming", () => {
  // Simulate `applyAgentEdit` append onto a blank doc: current = [emptyParagraph],
  // agent content = [h2, p]. The fixed merge trims boundary empties first.
  const agent = [heading("Background"), para("Body.")];
  const merged = [...trimBoundaryEmptyParagraphs([emptyPara]), ...agent];
  assert.equal(merged.length, 2, "no stranded empty paragraph");
  assert.equal(merged[0].type, "heading", "first block is the heading, not dead space");
});

check("trimBoundaryEmptyParagraphs trims leading AND trailing empties but PRESERVES interior ones", () => {
  const content = [emptyPara, heading("H"), emptyPara, para("mid"), emptyPara, emptyPara];
  const out = trimBoundaryEmptyParagraphs(content);
  // Leading empty dropped, trailing two dropped, the interior empty (intentional
  // editorial spacing between H and "mid") is preserved.
  assert.equal(out.length, 3, "leading + trailing empties removed, interior kept");
  assert.equal(out[0].type, "heading");
  assert.equal(out[1].type, "paragraph"); // the preserved interior empty
  assert.equal(out[2].type, "paragraph"); // "mid"
  assert.equal(out[2].content?.[0]?.text, "mid");
});

check("trimBoundaryEmptyParagraphs returns the SAME array reference when nothing to trim (no needless copy)", () => {
  const content = [heading("H"), para("body")];
  assert.equal(trimBoundaryEmptyParagraphs(content), content);
});

console.log(`\natrium-collab-bridge smoke: ${passed} checks passed`);
