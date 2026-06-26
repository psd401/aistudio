/**
 * Ambient types for `tiptap-markdown` (#1051).
 *
 * tiptap-markdown@0.9 ships only JS builds (es/umd) with no type declarations.
 * This shim types the surface Atrium uses: the `Markdown` TipTap extension and
 * the `editor.storage.markdown.getMarkdown()` serializer the document editor
 * calls to produce canonical markdown for snapshots.
 */
// This file MUST be a module (not a global script) so the `@tiptap/core` block
// below is treated as a module *augmentation* (merging into Storage) rather than
// a declaration that shadows the real package and hides its exports.
export {};

declare module "tiptap-markdown" {
  import type { Extension } from "@tiptap/core";

  export interface MarkdownOptions {
    html?: boolean;
    tightLists?: boolean;
    tightListClass?: string;
    bulletListMarker?: string;
    linkify?: boolean;
    breaks?: boolean;
    transformPastedText?: boolean;
    transformCopiedText?: boolean;
  }

  export const Markdown: Extension<MarkdownOptions>;
}

/**
 * Augment TipTap's editor storage so `editor.storage.markdown.getMarkdown()` is
 * typed wherever the editor instance is used.
 */
declare module "@tiptap/core" {
  interface Storage {
    markdown: {
      getMarkdown(): string;
    };
  }
}
