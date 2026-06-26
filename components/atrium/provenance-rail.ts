/**
 * Atrium provenance rail (TipTap)
 *
 * Issue #1051. Client-only extension that paints the green/purple rail. It adds a
 * node decoration to each top-level block carrying `data-author="human" | "agent"`
 * based on that block's dominant authorship (per-character vote over the
 * `atriumAuthored` marks — see provenance.ts). The colored left border is drawn by
 * CSS in styles/atrium-content.css, so this is purely a decoration pass (no DOM
 * math, recomputed only when the doc changes).
 *
 * This is the simpler, robust rebuild of Proof's absolute-positioned gutter:
 * per-block node decorations instead of hand-positioned segments.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode, MarkType } from "@tiptap/pm/model";
import {
  AUTHORED_MARK,
  authorKindOf,
  dominantBlockAuthor,
} from "@/lib/content/collab/provenance";

function buildDecorations(doc: PMNode, markType: MarkType | undefined): DecorationSet {
  if (!markType) return DecorationSet.empty;
  const decorations: Decoration[] = [];

  // ProseMirror Node.forEach (not array iteration): iterates top-level blocks with
  // their start offset.
  // eslint-disable-next-line unicorn/no-for-each -- ProseMirror Node API, not an array
  doc.forEach((block, offset) => {
    let human = 0;
    let agent = 0;
    block.descendants((child) => {
      if (child.isText) {
        const authored = child.marks.find((m) => m.type === markType);
        const len = child.text?.length ?? 0;
        const kind = authored ? authorKindOf(authored.attrs.by as string) : "unknown";
        if (kind === "human") human += len;
        else if (kind === "agent") agent += len;
      }
      return true;
    });

    const author = dominantBlockAuthor(human, agent);
    if (author) {
      decorations.push(
        Decoration.node(offset, offset + block.nodeSize, {
          "data-author": author,
          class: "atrium-rail-block",
        })
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const ProvenanceRail = Extension.create({
  name: "provenanceRail",

  addProseMirrorPlugins() {
    const markType = this.editor.schema.marks[AUTHORED_MARK];
    const key = new PluginKey<DecorationSet>("atriumProvenanceRail");

    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => buildDecorations(state.doc, markType),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc, markType) : old),
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
