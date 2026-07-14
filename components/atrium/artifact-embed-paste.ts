/**
 * Atrium embed-in-doc paste rule (#1052)
 *
 * Client-only TipTap extension: when a bare `::atrium-artifact{id="<uuid>"}`
 * directive is pasted into the document editor, convert it into the live
 * `atriumArtifactEmbed` block node instead of dropping it in as plain text. This
 * closes the loop with the rest of the embed pipeline — the node serializes BACK
 * to the same directive on snapshot (artifact-embed-node.ts), and the readers
 * render it as a live, visibility-gated sandbox — so an author can copy the
 * directive an agent surfaces (or another doc's source) and paste a working embed.
 *
 * Client-only by design (like AuthoredTracker / SuggestionMode): it is added to
 * the editor's extension list in DocumentEditor, NOT to the shared
 * `getSchemaExtensions()`. It adds a ProseMirror plugin (no schema change), so the
 * server transformer / collab bundle are untouched and client↔server schema parity
 * holds. The node it inserts carries ONLY `artifactId` (no title) — the same
 * title-leak-safe shape the shared schema defines — so a pasted embed is resolved
 * per-viewer through the visibility-gated resolver like every other embed.
 *
 * Scope: it handles a paste whose WHOLE payload is a single directive (optionally
 * surrounded by whitespace). Mixed content (prose that merely contains a directive
 * line) falls through to ProseMirror's default paste, so ordinary text is never
 * swallowed and a directive documented inside pasted prose is not silently
 * promoted to a live embed.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { ARTIFACT_EMBED_NODE_NAME } from "@/lib/content/collab/artifact-embed-node";
import {
  ARTIFACT_EMBED_LINE_RE,
  parseArtifactEmbedAttrs,
  isArtifactId,
} from "@/lib/content/embed-directive";

/**
 * Build the `atriumArtifactEmbed` node for a pasted string when — and only when —
 * the trimmed payload is exactly one embed directive carrying a valid artifact id.
 * Returns null otherwise (not a directive, malformed id, or the schema lacks the
 * node). Pure + schema-driven so the paste behavior is unit-testable without a
 * browser or a live editor.
 */
export function directiveToEmbedNode(
  schema: Schema,
  text: string
): ProseMirrorNode | null {
  // Whole-payload match only: ARTIFACT_EMBED_LINE_RE is anchored to a full line,
  // so `text.trim()` must BE the directive (not merely contain one).
  const match = text.trim().match(ARTIFACT_EMBED_LINE_RE);
  if (!match) return null;
  // Reuse the shared parser (extracts + UUID-validates the id) and re-assert via
  // isArtifactId so a future looser parser can never inject a bad lookup key.
  const id = parseArtifactEmbedAttrs(match[1]);
  if (!id || !isArtifactId(id)) return null;
  const type = schema.nodes[ARTIFACT_EMBED_NODE_NAME];
  if (!type) return null;
  return type.create({ artifactId: id });
}

export const ArtifactEmbedPaste = Extension.create({
  name: "atriumArtifactEmbedPaste",

  addProseMirrorPlugins() {
    // Bail if the embed node isn't in the schema (defensive — DocumentEditor
    // always mounts it via the shared schema).
    if (!this.editor.schema.nodes[ARTIFACT_EMBED_NODE_NAME]) return [];

    return [
      new Plugin({
        key: new PluginKey("atriumArtifactEmbedPaste"),
        props: {
          handlePaste: (view, event) => {
            // Only plain-text clipboard payloads carry the directive; if an app
            // put HTML on the clipboard, defer to ProseMirror's default paste.
            const text = event.clipboardData?.getData("text/plain");
            if (!text) return false;
            const node = directiveToEmbedNode(view.state.schema, text);
            if (!node) return false; // not a lone directive → default paste
            const tr = view.state.tr.replaceSelectionWith(node);
            view.dispatch(tr.scrollIntoView());
            return true; // handled — suppress the default plain-text paste
          },
        },
      }),
    ];
  },
});

export default ArtifactEmbedPaste;
