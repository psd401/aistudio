/**
 * Unit tests for the ProseMirror-JSON -> Markdown serializer (Atrium §1087).
 *
 * The serializer is PURE (no TipTap/Yjs imports) precisely so it can be jest-
 * tested here. Coverage: every node in the shared StarterKit schema
 * (doc/paragraph/heading/blockquote/bullet+ordered list/listItem/codeBlock/
 * horizontalRule/hardBreak), the four markdown-expressible marks
 * (bold/italic/strike/code) and their combinations, and — most importantly for
 * the §1087 read path — the "never throws" contract: unknown nodes degrade to
 * their children, unknown marks (Atrium provenance marks ride on EVERY text node)
 * are ignored, and malformed input yields "".
 */

import {
  proseMirrorJSONToMarkdown,
  type PMNode,
} from "@/lib/content/collab/prosemirror-markdown";

const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content });
const para = (...content: PMNode[]): PMNode => ({ type: "paragraph", content });
const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): PMNode => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});

describe("proseMirrorJSONToMarkdown — nodes", () => {
  it("serializes a paragraph", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("Hello world"))))).toBe("Hello world");
  });

  it("serializes headings at every level (and clamps out-of-range)", () => {
    expect(proseMirrorJSONToMarkdown(doc({ type: "heading", attrs: { level: 1 }, content: [text("H1")] }))).toBe("# H1");
    expect(proseMirrorJSONToMarkdown(doc({ type: "heading", attrs: { level: 3 }, content: [text("H3")] }))).toBe("### H3");
    expect(proseMirrorJSONToMarkdown(doc({ type: "heading", attrs: { level: 6 }, content: [text("H6")] }))).toBe("###### H6");
    // Out-of-range / missing level clamps into 1..6.
    expect(proseMirrorJSONToMarkdown(doc({ type: "heading", attrs: { level: 9 }, content: [text("Hi")] }))).toBe("###### Hi");
    expect(proseMirrorJSONToMarkdown(doc({ type: "heading", content: [text("NoLevel")] }))).toBe("# NoLevel");
  });

  it("separates block siblings with a blank line", () => {
    expect(
      proseMirrorJSONToMarkdown(
        doc({ type: "heading", attrs: { level: 2 }, content: [text("Title")] }, para(text("Body")))
      )
    ).toBe("## Title\n\nBody");
  });

  it("serializes a bullet list", () => {
    const list: PMNode = {
      type: "bulletList",
      content: [
        { type: "listItem", content: [para(text("one"))] },
        { type: "listItem", content: [para(text("two"))] },
      ],
    };
    expect(proseMirrorJSONToMarkdown(doc(list))).toBe("- one\n- two");
  });

  it("serializes an ordered list honoring the start attr", () => {
    const list: PMNode = {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        { type: "listItem", content: [para(text("c"))] },
        { type: "listItem", content: [para(text("d"))] },
      ],
    };
    expect(proseMirrorJSONToMarkdown(doc(list))).toBe("3. c\n4. d");
  });

  it("indents a nested list under its parent item", () => {
    const nested: PMNode = {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para(text("parent")),
            { type: "bulletList", content: [{ type: "listItem", content: [para(text("child"))] }] },
          ],
        },
      ],
    };
    expect(proseMirrorJSONToMarkdown(doc(nested))).toBe("- parent\n\n  - child");
  });

  it("serializes a blockquote, prefixing every line", () => {
    const bq: PMNode = { type: "blockquote", content: [para(text("line one")), para(text("line two"))] };
    expect(proseMirrorJSONToMarkdown(doc(bq))).toBe("> line one\n>\n> line two");
  });

  it("serializes a fenced code block with its language, marks-free", () => {
    const cb: PMNode = {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [text("const x = 1;\nconst y = 2;")],
    };
    expect(proseMirrorJSONToMarkdown(doc(cb))).toBe("```ts\nconst x = 1;\nconst y = 2;\n```");
  });

  it("widens the code fence when the code contains a backtick run", () => {
    const cb: PMNode = { type: "codeBlock", attrs: { language: "" }, content: [text("a ``` b")] };
    expect(proseMirrorJSONToMarkdown(doc(cb))).toBe("````\na ``` b\n````");
  });

  it("PRESERVES multiple blank lines inside a code block (no document-wide newline collapse)", () => {
    // Regression: a global `\n{3,}` collapse would corrupt preformatted content.
    const cb: PMNode = { type: "codeBlock", attrs: { language: "py" }, content: [text("a\n\n\nb")] };
    expect(proseMirrorJSONToMarkdown(doc(cb))).toBe("```py\na\n\n\nb\n```");
  });

  it("does not emit a 3+ newline run when a paragraph ends in a hardBreak", () => {
    // The trailing hardBreak is dropped at the block seam so the blank-line join stays clean.
    const out = proseMirrorJSONToMarkdown(doc(para(text("a"), { type: "hardBreak" }), para(text("b"))));
    expect(out).toBe("a\n\nb");
  });

  it("serializes a horizontal rule", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("a")), { type: "horizontalRule" }, para(text("b"))))).toBe(
      "a\n\n---\n\nb"
    );
  });

  it("renders a hardBreak as a line break inside a paragraph", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("a"), { type: "hardBreak" }, text("b"))))).toBe("a\nb");
  });
});

describe("proseMirrorJSONToMarkdown — marks", () => {
  it("bold", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("x", [{ type: "bold" }]))))).toBe("**x**");
  });
  it("italic", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("x", [{ type: "italic" }]))))).toBe("_x_");
  });
  it("strike", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("x", [{ type: "strike" }]))))).toBe("~~x~~");
  });
  it("inline code", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("x", [{ type: "code" }]))))).toBe("`x`");
  });
  it("bold + italic nest cleanly", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("x", [{ type: "bold" }, { type: "italic" }]))))).toBe("**_x_**");
  });
  it("code wins over formatting marks (markdown code spans are literal)", () => {
    expect(
      proseMirrorJSONToMarkdown(doc(para(text("x", [{ type: "code" }, { type: "bold" }]))))
    ).toBe("`x`");
  });
  it("widens the inline-code fence and pads when text contains backticks", () => {
    expect(proseMirrorJSONToMarkdown(doc(para(text("a`b", [{ type: "code" }]))))).toBe("``a`b``");
    expect(proseMirrorJSONToMarkdown(doc(para(text("`x`", [{ type: "code" }]))))).toBe("`` `x` ``");
  });
  it("mixes marked and plain runs within a paragraph", () => {
    expect(
      proseMirrorJSONToMarkdown(doc(para(text("Hello "), text("world", [{ type: "bold" }]), text("!"))))
    ).toBe("Hello **world**!");
  });
});

describe("proseMirrorJSONToMarkdown — never throws / graceful degradation", () => {
  it("ignores unknown marks (Atrium provenance marks ride on every text node)", () => {
    const marks = [{ type: "atriumAuthored", attrs: { by: "ai:bot" } }, { type: "bold" }];
    expect(proseMirrorJSONToMarkdown(doc(para(text("x", marks))))).toBe("**x**");
  });

  it("drops link/underline marks to plain text (out of §1087 scope) without failing", () => {
    const marks = [{ type: "link", attrs: { href: "https://x" } }, { type: "underline" }];
    expect(proseMirrorJSONToMarkdown(doc(para(text("click", marks))))).toBe("click");
  });

  it("recurses into an unknown node so its text survives", () => {
    const unknown: PMNode = { type: "mysteryWrapper", content: [para(text("kept"))] };
    expect(proseMirrorJSONToMarkdown(doc(unknown))).toBe("kept");
  });

  it("returns '' for null / undefined / empty document", () => {
    expect(proseMirrorJSONToMarkdown(null)).toBe("");
    expect(proseMirrorJSONToMarkdown(undefined)).toBe("");
    expect(proseMirrorJSONToMarkdown(doc())).toBe("");
  });

  it("returns '' for a document that is a single empty paragraph (new / title-only doc)", () => {
    expect(proseMirrorJSONToMarkdown(doc({ type: "paragraph" }))).toBe("");
  });

  it("does not throw on a deeply malformed tree", () => {
    const bad = { type: "doc", content: [{ marks: [{}], content: [{ type: "text" }] }] } as unknown as PMNode;
    expect(() => proseMirrorJSONToMarkdown(bad)).not.toThrow();
    expect(typeof proseMirrorJSONToMarkdown(bad)).toBe("string");
  });
});
