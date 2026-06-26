/**
 * Atrium markdown <-> Yjs document bridge
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Atrium's canonical storage is
 * markdown (Phase 0), but the live editor works in TipTap's native ProseMirror/
 * Yjs model. This module bridges the two at the seeding + agent-write boundaries,
 * stamping authorship as it goes.
 *
 * Seeding (markdown -> Y.Doc): an agent-drafted (or human-drafted) document's
 * markdown is parsed to editable HTML (via `marked`, plain — NOT the rich reader
 * pipeline, which adds KaTeX/sanitize artifacts unsuitable for editing), turned
 * into ProseMirror JSON against the shared schema, stamped with the creator's
 * author tag on every text node, then converted to a Y.Doc by y-prosemirror's
 * `prosemirrorJSONToYDoc`. The whole initial draft therefore reads as its
 * creator on the rail (purple for an agent draft, green for a human draft).
 *
 * This module imports the pure-ESM TipTap/Yjs stack and is therefore NOT
 * jest-loadable (next/jest cannot transform it); it is covered by the Bun smoke
 * test tests/smoke/atrium-collab-bridge.smoke.ts.
 */

import { marked } from "marked";
import { generateJSON } from "@tiptap/html";
import type { JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import type { Doc as YDoc } from "yjs";
import { getSchemaExtensions, getCollabSchema } from "./editor-extensions";
import { AUTHORED_MARK, COLLAB_FIELD } from "./provenance";

/**
 * Parse markdown into ProseMirror JSON against the shared Atrium schema.
 *
 * Trust model: `marked` converts markdown to HTML; that HTML then passes through
 * `generateJSON` which parses it against the ProseMirror schema — the schema acts
 * as the sanitization boundary (unknown tags and attributes are dropped). Do NOT
 * pipe this through the reader's rich pipeline (KaTeX, DOMPurify, etc.) — those
 * add artifacts that are unsuitable for the editable TipTap model.
 */
export function markdownToProseMirrorJSON(markdown: string): JSONContent {
  const html = marked.parse(markdown ?? "", { async: false });
  if (typeof html !== "string") {
    throw new TypeError("marked.parse returned a non-string; expected sync output");
  }
  return generateJSON(html, getSchemaExtensions());
}

/**
 * Return a deep copy of `node` with the `atriumAuthored` mark set to `by` on
 * every text node (replacing any existing author mark). Non-text nodes are
 * recursed into. Used to stamp a freshly-seeded draft with its creator.
 */
export function stampAuthor(node: JSONContent, by: string): JSONContent {
  const authoredMark = { type: AUTHORED_MARK, attrs: { by } };
  const walk = (n: JSONContent): JSONContent => {
    const next: JSONContent = { ...n };
    if (n.type === "text") {
      const kept = (n.marks ?? []).filter((m) => m.type !== AUTHORED_MARK);
      next.marks = [...kept, authoredMark];
    }
    if (Array.isArray(n.content)) {
      next.content = n.content.map(walk);
    }
    return next;
  };
  return walk(node);
}

/**
 * Build a Y.Doc for a fresh document from its markdown, stamped with the
 * creator's author tag. Returned doc is ready to hand back from Hocuspocus
 * `onLoadDocument` (its `COLLAB_FIELD` fragment is populated).
 */
export function seedYDocFromMarkdown(markdown: string, by: string): YDoc {
  const json = stampAuthor(markdownToProseMirrorJSON(markdown), by);
  return prosemirrorJSONToYDoc(getCollabSchema(), json, COLLAB_FIELD);
}

/** Convert a live Y.Doc back to ProseMirror JSON (for inspection / re-stamping). */
export function yDocToProseMirrorJSON(doc: YDoc): JSONContent {
  return yDocToProsemirrorJSON(doc, COLLAB_FIELD) as JSONContent;
}
