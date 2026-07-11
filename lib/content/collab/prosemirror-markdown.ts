/**
 * ProseMirror-JSON -> Markdown serializer (pure)
 *
 * Issue #1087 (Atrium §1087 / Nexus workspace chat). The live Atrium document
 * lives as a Yjs CRDT whose current text can only be read back as ProseMirror
 * JSON (`yDocToProseMirrorJSON`). The Nexus workspace-chat read tool needs that
 * text as MARKDOWN so the model can read what is actually on screen, but the
 * markdown-emitting extension (`tiptap-markdown`) is a CLIENT-only extension —
 * it is deliberately NOT in the shared server schema (see editor-extensions.ts).
 * This module is the missing server-side ProseMirror-JSON -> markdown direction,
 * the inverse of `markdownToProseMirrorJSON`.
 *
 * Design:
 * - PURE. No TipTap / Yjs / ProseMirror runtime imports (only a local structural
 *   node type), so it is unit-testable under jest — unlike markdown-bridge.ts,
 *   which pulls the ESM-only TipTap stack and is Bun-smoke-only.
 * - Covers the shared StarterKit node set (doc, paragraph, heading, blockquote,
 *   bulletList, orderedList, listItem, codeBlock, horizontalRule, hardBreak) and
 *   the four markdown-expressible marks (bold, italic, strike, code).
 * - NEVER THROWS. An unknown node degrades to its serialized children (so text
 *   inside an unrecognized wrapper still survives); an unknown mark (the Atrium
 *   provenance/comment/suggestion marks that ride on EVERY text node, plus
 *   `link`/`underline` which have no clean markdown form here) is ignored rather
 *   than failing. A read projection must degrade to plain text, never break the
 *   read tool. The whole entry point is additionally wrapped so a malformed tree
 *   yields "" instead of propagating.
 *
 * Not a goal: byte-perfect round-tripping of exotic constructs or escaping every
 * markdown metacharacter. The consumer is an LLM reading the doc plus a controlled
 * round-trip smoke; faithful, readable text beats aggressive escaping. Link hrefs
 * and underline styling are intentionally dropped (out of the §1087 scope).
 */

/** A single ProseMirror-JSON mark (the element type of a text node's `marks`). */
export interface PMMark {
  type?: string;
  attrs?: Record<string, unknown> | null;
}

/**
 * Minimal structural shape of a ProseMirror/TipTap JSON node. Declared locally
 * (no `@tiptap/core` import) so this module stays free of runtime ESM imports and
 * remains jest-loadable. `yDocToProseMirrorJSON`'s `JSONContent` output is
 * structurally compatible and can be passed directly.
 */
export interface PMNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown> | null;
  marks?: PMMark[];
  content?: PMNode[];
}

/** True when `node` carries a mark of the given type. */
function hasMark(node: PMNode, type: string): boolean {
  return (node.marks ?? []).some((m) => m?.type === type);
}

/**
 * Wrap inline text in a backtick code span, choosing a fence long enough to not
 * collide with any backtick run inside the text and padding with a single space
 * when the content touches a backtick (CommonMark inline-code rules).
 */
function wrapInlineCode(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Serialize a single text node, applying the markdown-expressible marks. Inline
 * `code` is literal — markdown emphasis does not render inside a code span — so a
 * `code` mark wins and the other formatting marks are ignored for that node.
 */
function serializeText(node: PMNode): string {
  const text = node.text ?? "";
  if (!text) return "";
  if (hasMark(node, "code")) return wrapInlineCode(text);
  let out = text;
  // Innermost -> outermost: italic, then bold, then strike.
  if (hasMark(node, "italic")) out = `_${out}_`;
  if (hasMark(node, "bold")) out = `**${out}**`;
  if (hasMark(node, "strike")) out = `~~${out}~~`;
  return out;
}

/** Serialize inline content (text + hardBreak, recursing into unknown inline wrappers). */
function serializeInline(nodes: PMNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += serializeText(n);
    else if (n.type === "hardBreak") out += "\n";
    else if (Array.isArray(n.content)) out += serializeInline(n.content);
    else if (typeof n.text === "string") out += serializeText(n);
    // else: an unknown, childless, textless inline node — skip (never throw).
  }
  return out;
}

/** Clamp a heading level into the 1..6 markdown range, defaulting to 1. */
function clampHeadingLevel(level: unknown): number {
  const n = typeof level === "number" ? level : Number(level);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(n)));
}

/** Coerce an ordered-list `start` attr into a >=1 integer, defaulting to 1. */
function toStart(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
}

/** Serialize a fenced code block; its content is literal text (marks ignored). */
function serializeCodeBlock(node: PMNode): string {
  const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const code = (node.content ?? []).map((n) => n.text ?? "").join("");
  const runs = code.match(/`{3,}/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}

/** Serialize a blockquote, prefixing every line of its inner blocks with `> `. */
function serializeBlockquote(node: PMNode): string {
  const inner = serializeBlocks(node.content);
  if (inner === "") return ">";
  return inner
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** Serialize a bullet/ordered list, indenting each item's continuation lines. */
function serializeList(node: PMNode, ordered: boolean): string {
  const items = (node.content ?? []).filter((c) => c.type === "listItem");
  const start = ordered ? toStart(node.attrs?.start) : 1;
  return items
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : "- ";
      const indent = " ".repeat(marker.length);
      const body = serializeBlocks(item.content);
      return body
        .split("\n")
        .map((line, idx) => (idx === 0 ? `${marker}${line}` : line ? `${indent}${line}` : line))
        .join("\n");
    })
    .join("\n");
}

/** Serialize one block node to markdown (may be multi-line). Never throws. */
function serializeBlock(node: PMNode): string {
  switch (node.type) {
    case "doc":
      return serializeBlocks(node.content);
    case "paragraph":
      return serializeInline(node.content);
    case "heading":
      return `${"#".repeat(clampHeadingLevel(node.attrs?.level))} ${serializeInline(node.content)}`;
    case "codeBlock":
      return serializeCodeBlock(node);
    case "blockquote":
      return serializeBlockquote(node);
    case "bulletList":
      return serializeList(node, false);
    case "orderedList":
      return serializeList(node, true);
    case "listItem":
      // Normally rendered by serializeList; standalone, emit its block children.
      return serializeBlocks(node.content);
    case "horizontalRule":
      return "---";
    case "hardBreak":
      return ""; // a block-level hardBreak should not occur; ignore defensively.
    case "text":
      return serializeText(node); // malformed (text at block level) — best effort.
    default:
      // Unknown node: never throw. Recurse into children so any text survives.
      if (Array.isArray(node.content)) return serializeBlocks(node.content);
      return typeof node.text === "string" ? serializeText(node) : "";
  }
}

/** Serialize a list of block nodes, dropping empties and joining with a blank line. */
function serializeBlocks(nodes: PMNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map(serializeBlock)
    .filter((s) => s !== "")
    .join("\n\n");
}

/**
 * Convert a ProseMirror/TipTap JSON document (as produced by
 * `yDocToProseMirrorJSON`) into markdown. Returns "" for a null/empty document
 * and, as a hard boundary guarantee, for any input that unexpectedly throws.
 */
export function proseMirrorJSONToMarkdown(doc: PMNode | null | undefined): string {
  if (!doc) return "";
  try {
    const out =
      doc.type === undefined || doc.type === "doc"
        ? serializeBlocks(doc.content)
        : serializeBlock(doc);
    // Collapse runaway blank lines and trim surrounding whitespace for a clean projection.
    return out.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}
