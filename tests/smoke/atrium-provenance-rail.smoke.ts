/**
 * Atrium provenance-rail decoration parity smoke test (Bun)
 *
 * Issue #1051 (PR #1062 review round 9). The rail plugin's `apply` no longer rebuilds
 * the whole DecorationSet on every keystroke; it incrementally recomputes only the
 * blocks a transaction touches (components/atrium/provenance-rail.ts:applyTransaction)
 * to avoid an O(doc) scan per keystroke. This test is the correctness oracle: for a
 * sequence of real ProseMirror transactions, the incremental result MUST equal what a
 * full `buildDecorations` rebuild would produce.
 *
 * Imports @tiptap/pm (pure ESM) so it runs under Bun, not jest.
 *
 * Run: `bun run tests/smoke/atrium-provenance-rail.smoke.ts`
 * Exits non-zero on the first failed assertion.
 */

import assert from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { AUTHORED_MARK } from "@/lib/content/collab/provenance";
import {
  applyTransaction,
  buildDecorations,
} from "@/components/atrium/provenance-rail";

// Minimal schema: doc -> paragraph+ -> text, with the atriumAuthored mark.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {
    [AUTHORED_MARK]: {
      attrs: { by: { default: "" } },
      toDOM: (m) => ["span", { "data-by": m.attrs.by as string }, 0],
    },
  },
});

const markType = schema.marks[AUTHORED_MARK];

function humanText(s: string) {
  return schema.text(s, [markType.create({ by: "human:1" })]);
}
function agentText(s: string) {
  return schema.text(s, [markType.create({ by: "ai:bot" })]);
}
function para(...inline: ReturnType<typeof schema.text>[]) {
  return schema.nodes.paragraph.create(null, inline);
}

/** Normalize a DecorationSet to a comparable sorted list of {from,to,author}. */
function snapshot(set: DecorationSet, docSize: number): string {
  const found = set
    .find(0, docSize)
    .map((d) => {
      // Decoration spec carries the data-author we set in blockDecoration.
      const spec = (d as unknown as { type: { attrs?: Record<string, string> } }).type;
      const author = spec?.attrs?.["data-author"] ?? "?";
      return `${d.from}-${d.to}:${author}`;
    })
    .sort();
  return found.join(",");
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * Run a sequence of transactions; after EACH, assert the incrementally-maintained
 * set equals a full rebuild of the current doc.
 */
function runSequence(
  name: string,
  startDoc: ReturnType<typeof schema.nodes.doc.create>,
  edits: Array<(state: EditorState) => EditorState>
): void {
  check(name, () => {
    let state = EditorState.create({ schema, doc: startDoc });
    let incremental = buildDecorations(state.doc, markType);
    // sanity: initial parity
    assert.equal(
      snapshot(incremental, state.doc.content.size),
      snapshot(buildDecorations(state.doc, markType), state.doc.content.size),
      `${name}: initial mismatch`
    );

    for (const [i, edit] of edits.entries()) {
      // `edit` dispatches a transaction via `dispatch`, which stashes the producing
      // transaction in `pendingTr` (EditorState does not retain it). Feed that exact
      // transaction to the incremental updater, then compare against a full rebuild.
      pendingTr = null;
      state = edit(state);
      assert.ok(pendingTr, `${name}: edit #${i + 1} did not dispatch a transaction`);
      incremental = applyTransaction(pendingTr, incremental, markType);
      const full = buildDecorations(state.doc, markType);
      assert.equal(
        snapshot(incremental, state.doc.content.size),
        snapshot(full, state.doc.content.size),
        `${name}: mismatch after edit #${i + 1}`
      );
    }
  });
}

// Capture the transaction each edit dispatched so runSequence can feed it to
// applyTransaction (EditorState doesn't retain the producing tr).
let pendingTr: import("@tiptap/pm/state").Transaction | null = null;
function dispatch(state: EditorState, build: (s: EditorState) => import("@tiptap/pm/state").Transaction): EditorState {
  const tr = build(state);
  pendingTr = tr;
  return state.apply(tr);
}

// --- Scenarios ---------------------------------------------------------------

// 1. Type human text into an agent-authored block: vote can flip agent -> human.
runSequence(
  "insert human text flips dominant author",
  schema.nodes.doc.create(null, [para(agentText("hello world"))]),
  [
    (s) =>
      dispatch(s, (st) =>
        // Insert a long human run at end of the paragraph so human chars > agent chars.
        st.tr.insert(st.doc.content.size - 1, humanText(" plus a much longer human addition here"))
      ),
  ]
);

// 2. Insert a new paragraph between two existing ones (block structure changes).
runSequence(
  "insert a new block shifts later block positions",
  schema.nodes.doc.create(null, [para(humanText("first")), para(agentText("second"))]),
  [
    (s) =>
      dispatch(s, (st) => {
        // Insert a fresh agent paragraph after the first block.
        const firstEnd = st.doc.child(0).nodeSize;
        return st.tr.insert(firstEnd, para(agentText("inserted")));
      }),
  ]
);

// 3. Delete most of an agent block so it becomes empty/unlabeled.
runSequence(
  "deleting all attributed text removes the decoration",
  schema.nodes.doc.create(null, [para(humanText("keep")), para(agentText("remove me"))]),
  [
    (s) =>
      dispatch(s, (st) => {
        const last = st.doc.child(0).nodeSize; // start of 2nd block
        const from = last + 1; // inside 2nd paragraph
        const to = st.doc.content.size - 1;
        return st.tr.delete(from, to);
      }),
  ]
);

// 4. Multi-step sequence across several blocks.
runSequence(
  "mixed sequence stays in parity",
  schema.nodes.doc.create(null, [
    para(humanText("alpha")),
    para(agentText("beta gamma")),
    para(humanText("delta")),
  ]),
  [
    (s) => dispatch(s, (st) => st.tr.insert(1, humanText("X"))),
    (s) => dispatch(s, (st) => st.tr.insert(st.doc.content.size - 1, agentText(" zeta zeta zeta"))),
    (s) =>
      dispatch(s, (st) => {
        // Add a human mark span into the middle agent block to flip it.
        const secondStart = st.doc.child(0).nodeSize + 1;
        return st.tr.insert(secondStart, humanText("HHHHHHHHHH"));
      }),
  ]
);

console.log(`\nAll ${passed} provenance-rail parity checks passed.`);
