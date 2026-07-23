/**
 * Atrium "authored" mark (TipTap)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). The provenance carrier — a ProseMirror
 * mark that records WHO authored a span via a `by` attribute ("human:<id>" /
 * "ai:<id>"). This is the rebuilt equivalent of Proof's `proofAuthored` mark.
 *
 * The mark must be in BOTH the client editor schema AND the server transformer
 * schema (see editor-extensions.ts) so the Yjs document maps consistently between
 * the browser and the server-side seeding/agent-bridge paths. It carries no
 * styling itself — the green/purple rail is computed per block from these marks
 * (see the provenance plugin in DocumentEditor) and the `data-author` it renders.
 *
 * `inclusive: true` so a human typing at the end of their own span keeps authoring
 * it. The same mark type cannot apply twice to one character, so re-marking a
 * range with a new `by` replaces the old author — exactly the "latest author of a
 * span wins" semantics provenance needs.
 */

import { Mark, mergeAttributes } from "@tiptap/core";
import { AUTHORED_MARK, authorKindOf } from "./provenance";

export interface AtriumAuthoredOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const AtriumAuthored = Mark.create<AtriumAuthoredOptions>({
  name: AUTHORED_MARK,
  inclusive: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      by: {
        default: "human:unknown",
        parseHTML: (element) => element.getAttribute("data-by") || "human:unknown",
        renderHTML: (attributes) => {
          const by = typeof attributes.by === "string" ? attributes.by : "human:unknown";
          // data-author is the coarse kind the rail/footer CSS keys off of;
          // data-by preserves the full tag for round-tripping.
          return { "data-by": by, "data-author": authorKindOf(by) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-atrium-authored]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-atrium-authored": "", class: "atrium-authored" }, HTMLAttributes),
      0,
    ];
  },
});
