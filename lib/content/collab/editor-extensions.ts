/**
 * Atrium shared TipTap schema extensions
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The ProseMirror schema must be
 * IDENTICAL on the client editor and on the server (seeding + agent bridge via
 * y-prosemirror), or the Yjs document maps inconsistently and edits corrupt.
 * This module is the single source of that schema: StarterKit (with
 * undo/redo disabled — Collaboration supplies Yjs-aware undo) plus the
 * `atriumAuthored` provenance mark, the §18.1 comment/suggestion marks, and —
 * from the Meridian redesign (Epic #1059 slice C) — the Table nodes and the
 * TextStyle/Color mark that back the floating formatting toolbar.
 *
 * Note: `undoRedo: false` is a PLUGIN change, not a schema change, so passing the
 * same configured StarterKit to the client (which adds Collaboration) and to the
 * server transformer (which ignores plugins) yields the same node/mark schema.
 * The client-only `Markdown` extension (tiptap-markdown) adds no schema nodes, so
 * it is intentionally NOT in this shared set — it lives only on the client where
 * `editor.storage.markdown.getMarkdown()` is needed.
 *
 * Meridian schema additions (slice C) — WHY they belong in this ONE shared set:
 *  - `TableKit` adds the `table` / `tableRow` / `tableHeader` / `tableCell` NODES.
 *    Its interactive plugins (column resizing, cell selection) are added by
 *    `addProseMirrorPlugins()`, which the server's `getSchema()` never calls — so
 *    the server transformer and collab bundle get the table nodes without the
 *    browser-only plugins, exactly like StarterKit's `undoRedo: false` precedent.
 *  - `TextStyle` + `Color` add the single `textStyle` MARK (Color writes the
 *    `color` attribute onto it). No new nodes.
 *  - Underline is intentionally NOT added here — StarterKit v3 already enables the
 *    `underline` mark by default, so the toolbar's U button toggles the existing
 *    mark; adding `@tiptap/extension-underline` again would register a duplicate
 *    extension and corrupt the shared schema.
 *  - `AtriumArtifactEmbed` (slice D) adds the `atriumArtifactEmbed` block ATOM node
 *    (an embedded-artifact reference). Schema-only here; its live React NodeView is
 *    attached CLIENT-side in DocumentEditor, so the server transformer / collab
 *    bundle get the node without any React dependency (same pattern as TableKit's
 *    browser-only plugins).
 * Because both the client editor and the server (markdown-bridge / agent bridge /
 * collab-server bundle) build from THIS function, editor and bridge stay in
 * lockstep automatically (asserted by tests/smoke/atrium-collab-schema.smoke.ts).
 */

import StarterKit from "@tiptap/starter-kit";
import { getSchema, type Extensions } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { TableKit } from "@tiptap/extension-table";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { AtriumAuthored } from "./authored-mark";
import { AtriumComment } from "./comment-mark";
import {
  AtriumSuggestionInsert,
  AtriumSuggestionDelete,
} from "./suggestion-marks";
import { AtriumArtifactEmbed } from "./artifact-embed-node";

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
    // Meridian floating-toolbar schema (slice C). TableKit → table nodes;
    // TextStyle+Color → the `textStyle` mark. Both are shared client↔server so the
    // Yjs document maps identically everywhere (see module header).
    TableKit,
    TextStyle,
    Color,
    // Meridian embedded-artifact node (slice D). A block ATOM referencing an
    // artifact by id, serialized to markdown as `::atrium-artifact{id="…"}`. Lives
    // in THIS shared set (like TableKit) so the client editor, server transformer,
    // and collab bundle build the identical schema — the live React NodeView is
    // attached client-side (DocumentEditor) and never touches the schema.
    AtriumArtifactEmbed,
    AtriumAuthored,
    // §18.1 comments + track-changes marks. These MUST live here (the ONE shared
    // schema) so the client editor, server transformer, agent bridge, and seeding
    // all build the identical schema — a mark added anywhere else corrupts the Yjs
    // document. They add marks only (no nodes), so the client/server schema parity
    // the module header guarantees still holds (asserted in atrium-collab-schema smoke).
    AtriumComment,
    AtriumSuggestionInsert,
    AtriumSuggestionDelete,
  ];
}

let schemaCache: Schema | null = null;

/**
 * The ProseMirror schema for the shared extensions, cached. Used by the server
 * (markdown<->Y.Doc bridge + agent edits) to build/read the collaborative doc
 * without a live editor. Must be the SAME schema the client editor uses.
 */
export function getCollabSchema(): Schema {
  if (!schemaCache) schemaCache = getSchema(getSchemaExtensions());
  return schemaCache;
}
