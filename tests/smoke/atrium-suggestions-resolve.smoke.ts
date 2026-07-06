/**
 * Atrium clean-publish RESOLVE smoke test (Bun) — Epic #1059, §18.1
 *
 * The reader-safety gate: `resolveDocToCleanJSON` must produce the accepted baseline
 * — pending INSERTION text removed, pending DELETION text kept, comment/suggestion
 * marks stripped — so published `source.md` (and the reader) carry no comment or
 * unaccepted-suggestion content, and critically no deleted text leaks through.
 *
 * Run: `bun run tests/smoke/atrium-suggestions-resolve.smoke.ts`
 */

import assert from "node:assert/strict";
import {
  resolveDocToCleanJSON,
  type PmNode,
} from "@/lib/content/collab/suggestions";
import { ATRIUM_COMMENT_MARK } from "@/lib/content/collab/comment-mark";
import {
  ATRIUM_SUGGESTION_INSERT_MARK,
  ATRIUM_SUGGESTION_DELETE_MARK,
} from "@/lib/content/collab/suggestion-marks";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function allText(node: PmNode, out: string[] = []): string[] {
  if (node.type === "text" && node.text) out.push(node.text);
  for (const c of node.content ?? []) allText(c, out);
  return out;
}
function allMarkTypes(node: PmNode, out: Set<string> = new Set()): Set<string> {
  for (const m of node.marks ?? []) out.add(m.type);
  for (const c of node.content ?? []) allMarkTypes(c, out);
  return out;
}

const doc: PmNode = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "keep " },
        {
          type: "text",
          text: "commented",
          marks: [{ type: ATRIUM_COMMENT_MARK, attrs: { threadId: "t-1" } }],
        },
        { type: "text", text: " " },
        {
          type: "text",
          text: "INSERTED",
          marks: [{ type: ATRIUM_SUGGESTION_INSERT_MARK, attrs: { suggestionId: "s-1" } }],
        },
        {
          type: "text",
          text: "DELETED",
          marks: [{ type: ATRIUM_SUGGESTION_DELETE_MARK, attrs: { suggestionId: "s-2" } }],
        },
      ],
    },
    // A block-level pending insertion (whole node) → dropped.
    { type: "paragraph", attrs: { suggestion: "insert" }, content: [{ type: "text", text: "NEW BLOCK" }] },
    // A block-level pending deletion → kept, attribute cleared.
    { type: "paragraph", attrs: { suggestion: "delete" }, content: [{ type: "text", text: "old block" }] },
  ],
};

const clean = resolveDocToCleanJSON(doc);
const text = allText(clean).join("");
const marks = allMarkTypes(clean);

check("pending INSERTION text is removed (not in the accepted baseline)", () => {
  assert.ok(!text.includes("INSERTED"), `inserted text leaked: ${text}`);
});

check("pending DELETION text is KEPT (deletion not yet applied)", () => {
  assert.ok(text.includes("DELETED"), `deleted text was dropped: ${text}`);
});

check("commented text is KEPT", () => {
  assert.ok(text.includes("commented"), `commented text lost: ${text}`);
});

check("ALL comment + suggestion marks are stripped", () => {
  assert.ok(!marks.has(ATRIUM_COMMENT_MARK), "comment mark survived");
  assert.ok(!marks.has(ATRIUM_SUGGESTION_INSERT_MARK), "insert mark survived");
  assert.ok(!marks.has(ATRIUM_SUGGESTION_DELETE_MARK), "delete mark survived");
});

check("block-level pending insertion node is dropped; pending deletion node kept + cleared", () => {
  assert.ok(!text.includes("NEW BLOCK"), "block insertion leaked");
  assert.ok(text.includes("old block"), "block pending-deletion was wrongly dropped");
  // The surviving block's suggestion attr is cleared.
  const blocks = clean.content ?? [];
  for (const b of blocks) {
    assert.ok(!(b.attrs && "suggestion" in b.attrs), "block suggestion attr not cleared");
  }
});

check("a doc with ONLY a pending insertion resolves to empty, never null", () => {
  const onlyInsert: PmNode = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: ATRIUM_SUGGESTION_INSERT_MARK }] }] },
    ],
  };
  const r = resolveDocToCleanJSON(onlyInsert);
  assert.equal(r.type, "doc");
  assert.ok(!allText(r).join("").includes("x"));
});

console.log(`\natrium-suggestions-resolve smoke: ${passed} checks passed`);
