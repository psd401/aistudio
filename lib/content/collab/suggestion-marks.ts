/**
 * Atrium track-changes marks (TipTap) — Epic #1059, §18.1
 *
 * Two marks that turn an edit into a PROPOSED change rather than a direct one, for
 * "suggesting mode":
 *  - `atriumSuggestionInsert` — text proposed for insertion (rendered as an
 *    underline). Accepting removes the mark (keeps text); rejecting deletes the text.
 *  - `atriumSuggestionDelete` — text proposed for deletion (rendered struck-through;
 *    the text is NOT actually removed yet). Accepting deletes the text; rejecting
 *    removes the mark (keeps text).
 *
 * Both MUST be in the single shared `getSchemaExtensions()` (see editor-extensions.ts)
 * so the client editor, the server transformer, the agent bridge, and seeding build
 * the IDENTICAL ProseMirror schema — a divergence corrupts the Yjs document.
 *
 * Both emit NOTHING to markdown. The `resolveDocToCleanJSON` transform
 * (`suggestions.ts`) is what actually RESOLVES suggestions for publish (drops a
 * pending insertion's text, keeps a pending deletion's text, strips both marks) —
 * the empty markdown serialize alone cannot drop the wrapped text, so the transform
 * is load-bearing for reader safety, not optional.
 *
 * `inclusive`: insert is `true` (continued typing extends the same suggestion),
 * delete is `false` (a deletion marks a fixed span).
 */

import { Mark, mergeAttributes } from "@tiptap/core";

export const ATRIUM_SUGGESTION_INSERT_MARK = "atriumSuggestionInsert";
export const ATRIUM_SUGGESTION_DELETE_MARK = "atriumSuggestionDelete";

interface SuggestionOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** Shared attribute set: a suggestion id (groups a change) + author tag + timestamp. */
function suggestionAttributes() {
  return {
    suggestionId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-suggestion-id"),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.suggestionId
          ? { "data-suggestion-id": attributes.suggestionId as string }
          : {},
    },
    by: {
      default: "human:unknown",
      parseHTML: (element: HTMLElement) => element.getAttribute("data-by") || "human:unknown",
      renderHTML: (attributes: Record<string, unknown>) => ({
        "data-by": typeof attributes.by === "string" ? attributes.by : "human:unknown",
      }),
    },
    at: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-at"),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.at ? { "data-at": attributes.at as string } : {},
    },
  };
}

/** Empty markdown serialize so a suggestion mark never emits syntax to `source.md`. */
function emptyMarkdownStorage() {
  return { markdown: { serialize: { open: () => "", close: () => "" } } };
}

export const AtriumSuggestionInsert = Mark.create<SuggestionOptions>({
  name: ATRIUM_SUGGESTION_INSERT_MARK,
  inclusive: true,
  excludes: "",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  addStorage() {
    return emptyMarkdownStorage();
  },
  addAttributes() {
    return suggestionAttributes();
  },
  parseHTML() {
    return [{ tag: 'span[data-suggestion="insert"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { "data-suggestion": "insert", class: "atrium-suggest-insert" },
        HTMLAttributes
      ),
      0,
    ];
  },
});

export const AtriumSuggestionDelete = Mark.create<SuggestionOptions>({
  name: ATRIUM_SUGGESTION_DELETE_MARK,
  inclusive: false,
  excludes: "",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  addStorage() {
    return emptyMarkdownStorage();
  },
  addAttributes() {
    return suggestionAttributes();
  },
  parseHTML() {
    return [{ tag: 'span[data-suggestion="delete"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { "data-suggestion": "delete", class: "atrium-suggest-delete" },
        HTMLAttributes
      ),
      0,
    ];
  },
});
