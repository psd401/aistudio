/**
 * Atrium authored-tracker (TipTap)
 *
 * Issue #1051. Client-only extension that stamps the current actor's author tag
 * onto every range the LOCAL user inserts/changes, so a human typing turns those
 * spans green (and an agent's pushed edits, which arrive pre-stamped `ai:`, stay
 * purple). The equivalent of Proof's authored-tracker plugin.
 *
 * It runs in `appendTransaction`: for local, doc-changing transactions (skipping
 * Yjs-origin/remote ones via `isChangeOrigin`) it collects the changed ranges from
 * the step maps and adds the `atriumAuthored` mark. Re-entrancy is safe — the
 * addMark it appends produces identity step maps (no position change), so the
 * follow-up pass finds no ranges and stops.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { AUTHORED_MARK } from "@/lib/content/collab/provenance";

export interface AuthoredTrackerOptions {
  /** The current actor's author tag, e.g. "human:42". */
  by: string;
}

export const AuthoredTracker = Extension.create<AuthoredTrackerOptions>({
  name: "authoredTracker",

  addOptions() {
    return { by: "human:unknown" };
  },

  addProseMirrorPlugins() {
    const by = this.options.by;
    const markType = this.editor.schema.marks[AUTHORED_MARK];
    if (!markType) return [];

    return [
      new Plugin({
        key: new PluginKey("atriumAuthoredTracker"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;

          const ranges: Array<[number, number]> = [];
          for (const tr of transactions) {
            // Filter PER TRANSACTION, not per batch: a local keystroke and a
            // remote (Yjs) edit can land in the same appendTransaction batch (the
            // user types at the instant an agent edit arrives). Skipping the whole
            // batch when ANY transaction is remote would drop the human's mark off
            // their own keystroke, rendering it with no rail colour. Remote edits
            // already carry their author's mark, so skip only those.
            if (isChangeOrigin(tr)) continue;
            for (const map of tr.mapping.maps) {
              // ProseMirror StepMap.forEach (not array iteration) — its callback
              // exposes the mapped (oldStart,oldEnd,newStart,newEnd) ranges.
              // eslint-disable-next-line unicorn/no-for-each -- StepMap API, not an array
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd > newStart) ranges.push([newStart, newEnd]);
              });
            }
          }
          if (ranges.length === 0) return null;

          const docSize = newState.doc.content.size;
          const mark = markType.create({ by });
          const tr = newState.tr;
          let modified = false;
          for (const [from, to] of ranges) {
            const f = Math.max(0, Math.min(from, docSize));
            const t = Math.max(0, Math.min(to, docSize));
            if (t > f) {
              tr.addMark(f, t, mark);
              modified = true;
            }
          }
          return modified ? tr : null;
        },
      }),
    ];
  },
});
