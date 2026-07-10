/**
 * Atrium track-changes resolution — Epic #1059, §18.1
 *
 * The LOAD-BEARING reader-safety transform. tiptap-markdown's `html:true` default
 * serializes any mark it doesn't recognize as inline `<span>` HTML, and the
 * markdown renderer's sanitizer strips the `<span>` but KEEPS the wrapped text — so
 * a pending-deletion span, or a comment span, would leak its text into the published
 * reader. A mark's empty markdown-serialize helps for the mark syntax, but it cannot
 * DROP the text a mark wraps. This transform is what actually resolves suggestions
 * and strips comments to the accepted baseline BEFORE markdown is produced.
 *
 * Publish policy (accepted baseline, product decision): a document publishes as its
 * currently-accepted text —
 *  - a PENDING INSERTION (`atriumSuggestionInsert`) is NOT yet part of the baseline
 *    → its text is REMOVED,
 *  - a PENDING DELETION (`atriumSuggestionDelete`) is NOT yet applied → its text is
 *    KEPT (mark dropped),
 *  - a COMMENT anchor is stripped (text kept).
 * Pending suggestions are not lost — they remain in the live Y.Doc / `atrium_doc_state`;
 * only the PUBLISHED snapshot is the baseline.
 *
 * `resolveDocToCleanJSON` is pure (ProseMirror-JSON → ProseMirror-JSON) so it is
 * unit-testable without a live editor or DB. `toCleanMarkdown` is the thin client
 * glue that runs it before `getMarkdown()`.
 */

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  ATRIUM_SUGGESTION_INSERT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
} from "./suggestion-marks";
import { ATRIUM_COMMENT_MARK } from "./comment-mark";

/** Marks stripped from surviving text on a clean publish (text is kept). */
const STRIP_MARKS = new Set<string>([
  ATRIUM_COMMENT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
]);

/** A minimal ProseMirror-JSON node shape (only the fields we read/rewrite). */
export interface PmNode {
  type: string;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: PmNode[];
  attrs?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Whether a node carries a given mark type. */
function hasMark(node: PmNode, markType: string): boolean {
  return (node.marks ?? []).some((m) => m.type === markType);
}

/**
 * Resolve one node to its clean-baseline form, or `null` when the node must be
 * dropped entirely (a pending inserted-text node, or a block flagged as a pending
 * insertion). Recurses into content.
 */
function cleanNode(node: PmNode): PmNode | null {
  // Block-level pending insertion (a whole node proposed for insertion) → drop it.
  // Block-level pending deletion → keep the node (deletion not yet applied) but
  // clear the suggestion attribute so it renders clean.
  const blockSuggestion = node.attrs?.suggestion as string | undefined;
  if (blockSuggestion === "insert") return null;

  // Inline pending insertion text → drop (not part of the accepted baseline).
  if (node.type === "text" && hasMark(node, ATRIUM_SUGGESTION_INSERT_MARK)) {
    return null;
  }

  let next: PmNode = node;

  // Strip comment + pending-deletion marks from surviving text (keep the text).
  if (node.marks && node.marks.length > 0) {
    const kept = node.marks.filter((m) => !STRIP_MARKS.has(m.type));
    next = kept.length > 0 ? { ...next, marks: kept } : omitKey(next, "marks");
  }

  // Clear a block-level pending-deletion suggestion attribute (keep the node).
  if (blockSuggestion) {
    next = { ...next, attrs: omitKey(next.attrs ?? {}, "suggestion") };
  }

  if (node.content && node.content.length > 0) {
    const content = node.content
      .map(cleanNode)
      .filter((n): n is PmNode => n !== null);
    next = { ...next, content };
  }
  return next;
}

/** Return a shallow copy of `obj` without `key`. */
function omitKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  const { [key]: _omit, ...rest } = obj;
  return rest as T;
}

/**
 * Resolve a ProseMirror-JSON document to its published baseline: pending insertions
 * removed, pending deletions kept, comment/suggestion marks stripped. Pure.
 */
export function resolveDocToCleanJSON(doc: PmNode): PmNode {
  return cleanNode(doc) ?? { type: "doc", content: [] };
}

/* ---------------------------------------------------------------------------
 * Live-editor glue (client). The functions below take a TipTap `Editor` but
 * import it TYPE-ONLY, so this module stays runtime-pure (no TipTap/ProseMirror
 * runtime import) and remains loadable by the Bun resolve smoke and the client.
 * ------------------------------------------------------------------------- */

/** The tiptap-markdown storage surface this module needs (`serializer.serialize`). */
interface MarkdownEditorStorage {
  markdown: { serializer: { serialize: (content: PMNode) => string } };
}

/**
 * Serialize the editor's CURRENT document to clean, accepted-baseline markdown:
 * run `resolveDocToCleanJSON` over the live JSON (pending insertions removed,
 * pending deletions kept, comment/suggestion marks stripped), rebuild a
 * ProseMirror node against the editor schema, then serialize with the editor's
 * own tiptap-markdown serializer. This is what the snapshot/publish body source
 * must use INSTEAD of `editor.storage.markdown.getMarkdown()` so no comment or
 * unaccepted-suggestion residue (and no deleted text) can leak into `source.md`.
 */
export function toCleanMarkdown(editor: Editor): string {
  const cleaned = resolveDocToCleanJSON(editor.getJSON() as unknown as PmNode);
  const node = editor.schema.nodeFromJSON(cleaned);
  const storage = editor.storage as unknown as MarkdownEditorStorage;
  return storage.markdown.serializer.serialize(node);
}

/** One inline mark range in document coordinates. */
interface MarkedRange {
  from: number;
  to: number;
}

/**
 * Collect every inline text range carrying `markName`, optionally filtered to a
 * single `suggestionId` (pass `null` for all groups). Ranges are returned in
 * document order; the caller applies deletions high→low to keep positions valid.
 */
function collectMarkedRanges(
  editor: Editor,
  markName: string,
  suggestionId: string | null
): MarkedRange[] {
  const markType = editor.schema.marks[markName];
  if (!markType) return [];
  const ranges: MarkedRange[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type === markType);
    if (!mark) return true;
    if (suggestionId !== null && mark.attrs.suggestionId !== suggestionId) {
      return true;
    }
    ranges.push({ from: pos, to: pos + node.nodeSize });
    return true;
  });
  return ranges;
}

type RangeDisposition = "keep" | "remove";

/**
 * Resolve suggestion ranges in ONE transaction. For each mark kind, `keep` drops
 * the mark but keeps the text (removeMark, no position shift) and `remove` deletes
 * the text. Deletions are applied highest-first so earlier positions stay valid,
 * and removeMark steps never shift positions — so the original coordinates hold
 * for the whole transaction. Returns false (no dispatch) when nothing matched.
 */
function applySuggestionResolution(
  editor: Editor,
  opts: {
    suggestionId: string | null;
    insert: RangeDisposition;
    delete: RangeDisposition;
  }
): boolean {
  const insertType = editor.schema.marks[ATRIUM_SUGGESTION_INSERT_MARK];
  const deleteType = editor.schema.marks[ATRIUM_SUGGESTION_DELETE_MARK];
  const tr = editor.state.tr;
  const deletions: MarkedRange[] = [];

  for (const r of collectMarkedRanges(editor, ATRIUM_SUGGESTION_INSERT_MARK, opts.suggestionId)) {
    if (opts.insert === "keep" && insertType) tr.removeMark(r.from, r.to, insertType);
    else if (opts.insert === "remove") deletions.push(r);
  }
  for (const r of collectMarkedRanges(editor, ATRIUM_SUGGESTION_DELETE_MARK, opts.suggestionId)) {
    if (opts.delete === "keep" && deleteType) tr.removeMark(r.from, r.to, deleteType);
    else if (opts.delete === "remove") deletions.push(r);
  }

  deletions.sort((a, b) => b.from - a.from);
  for (const r of deletions) tr.delete(r.from, r.to);

  if (tr.steps.length === 0) return false;
  editor.view.dispatch(tr);
  return true;
}

/**
 * Accept one suggestion group: keep inserted text (drop the insert mark) and
 * delete text proposed for deletion — the accepted-baseline outcome for that id.
 */
export function acceptSuggestion(editor: Editor, suggestionId: string): boolean {
  return applySuggestionResolution(editor, {
    suggestionId,
    insert: "keep",
    delete: "remove",
  });
}

/**
 * Reject one suggestion group: delete the proposed insertion and keep the
 * originally-there text (drop the delete mark) — i.e. restore the prior baseline.
 */
export function rejectSuggestion(editor: Editor, suggestionId: string): boolean {
  return applySuggestionResolution(editor, {
    suggestionId,
    insert: "remove",
    delete: "keep",
  });
}

/**
 * Accept ALL pending suggestions to the accepted baseline (every insertion kept,
 * every deletion applied). Mirrors `resolveDocToCleanJSON`, but in-place on the
 * live doc so it flows through Yjs as a normal collaborative edit.
 */
export function acceptAllSuggestions(editor: Editor): boolean {
  return applySuggestionResolution(editor, {
    suggestionId: null,
    insert: "keep",
    delete: "remove",
  });
}

/**
 * Count the distinct pending-suggestion groups in the doc (insert + delete marks,
 * deduped by `suggestionId`). Drives the toolbar's non-blocking "N unresolved
 * suggestions" hint. A group with no id is counted per anchor position.
 */
export function countSuggestions(editor: Editor): number {
  const insertType = editor.schema.marks[ATRIUM_SUGGESTION_INSERT_MARK];
  const deleteType = editor.schema.marks[ATRIUM_SUGGESTION_DELETE_MARK];
  if (!insertType && !deleteType) return 0;
  const ids = new Set<string>();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type === insertType || mark.type === deleteType) {
        const id = mark.attrs.suggestionId;
        ids.add(typeof id === "string" && id.length > 0 ? id : `pos:${pos}`);
      }
    }
    return true;
  });
  return ids.size;
}
