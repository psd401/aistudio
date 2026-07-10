/**
 * Unit: toCleanMarkdown glue (Epic #1059, §18.1).
 *
 * `toCleanMarkdown` is the snapshot/publish body source: it must run the doc
 * through `resolveDocToCleanJSON` (pending insertion removed, pending deletion
 * kept, comment/suggestion marks stripped) BEFORE serializing to markdown, so the
 * canonical body carries no comment/suggestion residue and no deleted text.
 *
 * The mark modules are mocked to plain name constants so this test loads without
 * the (non-jest-transformable) TipTap runtime; a fake editor supplies getJSON /
 * schema.nodeFromJSON / the markdown serializer, exercising the resolve→node→
 * serialize wiring the real editor uses. `resolveDocToCleanJSON` itself is covered
 * end-to-end by tests/smoke/atrium-suggestions-resolve.smoke.ts.
 */

jest.mock("@/lib/content/collab/comment-mark", () => ({
  ATRIUM_COMMENT_MARK: "atriumComment",
}));
jest.mock("@/lib/content/collab/suggestion-marks", () => ({
  ATRIUM_SUGGESTION_INSERT_MARK: "atriumSuggestionInsert",
  ATRIUM_SUGGESTION_DELETE_MARK: "atriumSuggestionDelete",
}));

import type { Editor } from "@tiptap/core";
import { toCleanMarkdown, type PmNode } from "@/lib/content/collab/suggestions";

/** A tiny text-only "serializer": walks the node and joins its text (marks gone). */
function serializeText(node: PmNode): string {
  const out: string[] = [];
  const walk = (n: PmNode) => {
    if (n.type === "text" && n.text) out.push(n.text);
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return out.join("");
}

/** A fake editor whose serializer is the text-join above. */
function fakeEditor(doc: PmNode): Editor {
  return {
    getJSON: () => doc,
    schema: { nodeFromJSON: (json: PmNode) => json },
    storage: { markdown: { serializer: { serialize: serializeText } } },
  } as unknown as Editor;
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
          marks: [{ type: "atriumComment", attrs: { threadId: "t-1" } }],
        },
        { type: "text", text: " " },
        {
          type: "text",
          text: "INSERTED",
          marks: [{ type: "atriumSuggestionInsert", attrs: { suggestionId: "s-1" } }],
        },
        {
          type: "text",
          text: "DELETED",
          marks: [{ type: "atriumSuggestionDelete", attrs: { suggestionId: "s-2" } }],
        },
      ],
    },
  ],
};

describe("toCleanMarkdown", () => {
  it("removes pending insertions, keeps pending deletions + commented text", () => {
    const md = toCleanMarkdown(fakeEditor(doc));
    expect(md).not.toContain("INSERTED");
    expect(md).toContain("DELETED");
    expect(md).toContain("commented");
    expect(md).toContain("keep");
  });

  it("serializes a doc of only a pending insertion to empty (never throws)", () => {
    const onlyInsert: PmNode = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "draft",
              marks: [{ type: "atriumSuggestionInsert", attrs: { suggestionId: "x" } }],
            },
          ],
        },
      ],
    };
    expect(toCleanMarkdown(fakeEditor(onlyInsert))).not.toContain("draft");
  });
});
