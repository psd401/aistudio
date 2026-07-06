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
