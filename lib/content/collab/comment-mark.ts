/**
 * Atrium "comment" mark (TipTap) — Epic #1059, §18.1
 *
 * The ANCHOR for a comment thread: a ProseMirror mark carrying a `threadId` that
 * ties a span of text to a thread in `atrium_doc_comments`. The mark (not a stored
 * byte offset) is the anchor so it moves with its text through every concurrent
 * CRDT edit — the same reason `AtriumAuthored` uses a mark. Thread BODIES (root +
 * replies + resolved) live in Postgres; only the anchor lives in the Y.Doc.
 *
 * Like every custom mark it MUST be in both the client editor schema and the server
 * transformer schema via the single `getSchemaExtensions()` (see editor-extensions.ts),
 * or the Yjs document maps inconsistently and edits corrupt.
 *
 * `inclusive: false` — a comment must NOT auto-extend onto text typed at its edge
 * (unlike authorship, a comment anchors a FIXED span the reviewer selected).
 *
 * Markdown: the mark emits NOTHING to markdown (empty serialize). Combined with the
 * `resolveDocToCleanJSON` publish transform (see `suggestions.ts`), this guarantees
 * a published document carries no comment markup — belt-and-suspenders, because
 * tiptap-markdown's `html:true` default would otherwise serialize an unmapped mark
 * as inline `<span>` HTML.
 */

import { Mark, mergeAttributes } from "@tiptap/core";

export const ATRIUM_COMMENT_MARK = "atriumComment";

export interface AtriumCommentOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const AtriumComment = Mark.create<AtriumCommentOptions>({
  name: ATRIUM_COMMENT_MARK,
  inclusive: false,
  // Comments can overlap authorship and suggestion marks on the same span.
  excludes: "",

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addStorage() {
    // tiptap-markdown consults `storage.markdown.serialize`; emit nothing so the
    // anchor never leaks into `source.md` even under the `html:true` default.
    return { markdown: { serialize: { open: () => "", close: () => "" } } };
  },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-thread-id"),
        renderHTML: (attributes) =>
          attributes.threadId ? { "data-thread-id": attributes.threadId as string } : {},
      },
      resolved: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-resolved") === "true",
        renderHTML: (attributes) => ({ "data-resolved": attributes.resolved ? "true" : "false" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-thread]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-comment-thread": "", class: "atrium-comment" }, HTMLAttributes),
      0,
    ];
  },
});
