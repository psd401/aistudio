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
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode, MarkType } from "@tiptap/pm/model";
import {
  AUTHORED_MARK,
  authorKindOf,
  dominantBlockAuthor,
} from "@/lib/content/collab/provenance";

/** Per-character authorship vote over one block -> the data-author decoration, or null. */
function blockDecoration(
  block: PMNode,
  offset: number,
  markType: MarkType
): Decoration | null {
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
  if (!author) return null;
  return Decoration.node(offset, offset + block.nodeSize, {
    "data-author": author,
    class: "atrium-rail-block",
  });
}

// Exported for the decoration-parity smoke test (tests/smoke/atrium-provenance-rail.smoke.ts):
// applyTransaction must always produce the same set a full buildDecorations would.
export function buildDecorations(doc: PMNode, markType: MarkType | undefined): DecorationSet {
  if (!markType) return DecorationSet.empty;
  const decorations: Decoration[] = [];

  // ProseMirror Node.forEach (not array iteration): iterates top-level blocks with
  // their start offset.
  // eslint-disable-next-line unicorn/no-for-each -- ProseMirror Node API, not an array
  doc.forEach((block, offset) => {
    const deco = blockDecoration(block, offset, markType);
    if (deco) decorations.push(deco);
  });

  return DecorationSet.create(doc, decorations);
}

/** Collect the transaction's changed ranges in NEW-document coordinates. */
function collectChangedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const map of tr.mapping.maps) {
    // StepMap.forEach is a ProseMirror API (not an array iterator).
    // eslint-disable-next-line unicorn/no-for-each -- ProseMirror StepMap API
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push({ from: newStart, to: newEnd });
    });
  }
  return ranges;
}

/** Mutable accumulator threaded through recomputeBlocksInRange across changed ranges. */
interface RecomputeContext {
  doc: PMNode;
  markType: MarkType;
  /** The currently-mapped decoration set to diff against. */
  current: DecorationSet;
  /** Blocks already recomputed (dedupe across overlapping changed ranges). */
  seenBlockStarts: Set<number>;
  toRemove: Decoration[];
  toAdd: Decoration[];
}

/**
 * Recompute the rail decoration for every top-level block overlapping [from, to]
 * in `ctx.doc`, appending stale decorations to `ctx.toRemove` and fresh ones to
 * `ctx.toAdd`. `ctx.seenBlockStarts` dedupes blocks touched by >1 changed range.
 */
function recomputeBlocksInRange(ctx: RecomputeContext, from: number, to: number): void {
  const { doc, markType, current, seenBlockStarts, toRemove, toAdd } = ctx;
  const lo = Math.max(0, Math.min(from, doc.content.size));
  const hi = Math.max(0, Math.min(to, doc.content.size));
  let pos = lo;
  while (pos <= hi) {
    const $pos = doc.resolve(Math.min(pos, doc.content.size));
    // depth 0 is the doc; depth 1 is the top-level block we decorate.
    const block = $pos.depth >= 1 ? $pos.node(1) : null;
    if (!block) {
      pos += 1;
      continue;
    }
    const blockStart = $pos.before(1);
    const blockEnd = blockStart + block.nodeSize;
    if (!seenBlockStarts.has(blockStart)) {
      seenBlockStarts.add(blockStart);
      for (const deco of current.find(blockStart, blockEnd)) {
        if (deco.from === blockStart) toRemove.push(deco);
      }
      const deco = blockDecoration(block, blockStart, markType);
      if (deco) toAdd.push(deco);
    }
    pos = blockEnd; // jump to the next block
  }
}

/**
 * Incrementally update the rail decorations for a single transaction.
 *
 * A full rebuild walks every block + every text node — an O(doc) scan on EACH
 * keystroke under active typing. But a content edit can only change the dominant
 * author of the block(s) it actually touches (the vote is per-block). So: map the
 * existing decoration set through the step mapping (cheap, O(changes)) to keep all
 * untouched blocks correctly positioned, then recompute ONLY the blocks overlapping
 * the changed ranges in the NEW doc and splice those back in. This stays correct for
 * this editor's "typed text carries the authored mark" model (where a plain rebuild
 * heuristic keyed on mark-steps would miss vote changes) while avoiding the per-doc scan.
 *
 * Parity with buildDecorations is asserted by tests/smoke/atrium-provenance-rail.smoke.ts.
 */
export function applyTransaction(
  tr: Transaction,
  old: DecorationSet,
  markType: MarkType | undefined
): DecorationSet {
  if (!markType) return DecorationSet.empty;

  const changedRanges = collectChangedRanges(tr);
  // Reposition existing decorations (cheap). When nothing changed structurally we
  // still return the mapped set so positions track the new doc.
  let next = old.map(tr.mapping, tr.doc);
  if (changedRanges.length === 0) return next;

  const ctx: RecomputeContext = {
    doc: tr.doc,
    markType,
    current: next,
    seenBlockStarts: new Set<number>(),
    toRemove: [],
    toAdd: [],
  };

  for (const range of changedRanges) {
    recomputeBlocksInRange(ctx, range.from, range.to);
  }

  if (ctx.toRemove.length > 0) next = next.remove(ctx.toRemove);
  if (ctx.toAdd.length > 0) next = next.add(ctx.doc, ctx.toAdd);
  return next;
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
          // On a doc change, incrementally recompute only the touched blocks instead
          // of rescanning the whole document on every keystroke (see applyTransaction).
          apply: (tr, old) =>
            tr.docChanged ? applyTransaction(tr, old, markType) : old,
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
