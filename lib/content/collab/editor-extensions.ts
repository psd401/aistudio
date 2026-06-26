/**
 * Atrium shared TipTap schema extensions
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The ProseMirror schema must be
 * IDENTICAL on the client editor and on the server (seeding + agent bridge via
 * @hocuspocus/transformer), or the Yjs document maps inconsistently and edits
 * corrupt. This module is the single source of that schema: StarterKit (with
 * undo/redo disabled — Collaboration supplies Yjs-aware undo) plus the
 * `atriumAuthored` provenance mark.
 *
 * Note: `undoRedo: false` is a PLUGIN change, not a schema change, so passing the
 * same configured StarterKit to the client (which adds Collaboration) and to the
 * server transformer (which ignores plugins) yields the same node/mark schema.
 * The client-only `Markdown` extension (tiptap-markdown) adds no schema nodes, so
 * it is intentionally NOT in this shared set — it lives only on the client where
 * `editor.storage.markdown.getMarkdown()` is needed.
 */

import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/core";
import { AtriumAuthored } from "./authored-mark";

/**
 * The schema-defining extensions shared by client editor and server transformer.
 * Always call this (don't share a singleton array) so each consumer gets fresh
 * extension instances.
 */
export function getSchemaExtensions(): Extensions {
  return [
    StarterKit.configure({
      // Collaboration provides Yjs-aware history; the default history plugin
      // would fight it. Disabling it changes no schema nodes.
      undoRedo: false,
    }),
    AtriumAuthored,
  ];
}
