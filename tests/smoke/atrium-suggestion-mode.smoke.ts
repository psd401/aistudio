/**
 * Atrium suggestion RESOLUTION smoke test (Bun) — Epic #1059, §18.1
 *
 * The accept/reject command helpers (lib/content/collab/suggestions.ts) mutate the
 * LIVE editor doc to the accepted/rejected baseline. They run against a real
 * ProseMirror schema (built from the shared getSchemaExtensions), so they're
 * verified here under Bun rather than jest (the schema stack is pure ESM):
 *   accept-insert  = keep text, drop the insert mark
 *   reject-insert  = delete the inserted text
 *   accept-delete  = delete the struck text
 *   reject-delete  = keep text, drop the delete mark
 *   accept-all     = accepted baseline (insertions kept, deletions applied)
 *   countSuggestions = distinct pending groups
 *
 * Run: `bun run tests/smoke/atrium-suggestion-mode.smoke.ts`
 */

import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getSchemaExtensions } from "@/lib/content/collab/editor-extensions";
import {
  ATRIUM_SUGGESTION_INSERT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
} from "@/lib/content/collab/suggestion-marks";
import {
  acceptSuggestion,
  rejectSuggestion,
  acceptAllSuggestions,
  countSuggestions,
} from "@/lib/content/collab/suggestions";

const schema = getSchema(getSchemaExtensions());
const insertType = schema.marks[ATRIUM_SUGGESTION_INSERT_MARK];
const deleteType = schema.marks[ATRIUM_SUGGESTION_DELETE_MARK];

/** Build a doc: "keep " + INS(insert,s-ins) + DEL(delete,s-del) + " end". */
function buildDoc(): PMNode {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [
      schema.text("keep "),
      schema.text("INS", [insertType.create({ suggestionId: "s-ins", by: "human:1" })]),
      schema.text("DEL", [deleteType.create({ suggestionId: "s-del", by: "human:1" })]),
      schema.text(" end"),
    ]),
  ]);
}

/** A fake editor whose dispatch applies the transaction to a mutable state. */
function makeEditor(): Editor {
  let state = EditorState.create({ schema, doc: buildDoc() });
  return {
    get state() {
      return state;
    },
    schema,
    view: {
      dispatch(tr: import("@tiptap/pm/state").Transaction) {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
}

function docText(editor: Editor): string {
  let out = "";
  editor.state.doc.descendants((n) => {
    if (n.isText) out += n.text ?? "";
    return true;
  });
  return out;
}

function hasMark(editor: Editor, markName: string, id?: string): boolean {
  let found = false;
  editor.state.doc.descendants((n) => {
    if (n.isText) {
      for (const m of n.marks) {
        if (m.type.name === markName && (id === undefined || m.attrs.suggestionId === id)) {
          found = true;
        }
      }
    }
    return true;
  });
  return found;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

check("countSuggestions counts distinct pending groups", () => {
  assert.equal(countSuggestions(makeEditor()), 2);
});

check("accept-insert keeps text, drops the insert mark; leaves the delete group", () => {
  const editor = makeEditor();
  acceptSuggestion(editor, "s-ins");
  assert.ok(docText(editor).includes("INS"), "inserted text was wrongly removed");
  assert.ok(!hasMark(editor, ATRIUM_SUGGESTION_INSERT_MARK), "insert mark survived accept");
  assert.ok(hasMark(editor, ATRIUM_SUGGESTION_DELETE_MARK, "s-del"), "unrelated delete group touched");
});

check("reject-insert deletes the inserted text", () => {
  const editor = makeEditor();
  rejectSuggestion(editor, "s-ins");
  assert.ok(!docText(editor).includes("INS"), "inserted text survived reject");
  assert.ok(!hasMark(editor, ATRIUM_SUGGESTION_INSERT_MARK), "insert mark survived reject");
});

check("accept-delete removes the struck text", () => {
  const editor = makeEditor();
  acceptSuggestion(editor, "s-del");
  assert.ok(!docText(editor).includes("DEL"), "struck text survived accept-delete");
});

check("reject-delete keeps text, drops the delete mark", () => {
  const editor = makeEditor();
  rejectSuggestion(editor, "s-del");
  assert.ok(docText(editor).includes("DEL"), "struck text was wrongly removed on reject-delete");
  assert.ok(!hasMark(editor, ATRIUM_SUGGESTION_DELETE_MARK), "delete mark survived reject-delete");
});

check("accept-all resolves to the accepted baseline (INS kept, DEL removed, no marks)", () => {
  const editor = makeEditor();
  acceptAllSuggestions(editor);
  const text = docText(editor);
  assert.ok(text.includes("INS"), "insertion not kept in baseline");
  assert.ok(!text.includes("DEL"), "deletion not applied in baseline");
  assert.equal(text, "keep INS end");
  assert.equal(countSuggestions(editor), 0, "pending suggestions remained after accept-all");
});

console.log(`\natrium-suggestion-mode smoke: ${passed} checks passed`);
