const { describe, expect, it } = require("bun:test");
const { stripHtmlMarkup } = require("../html-to-text");

describe("stripHtmlMarkup", () => {
  it("preserves readable text while removing generated markup", () => {
    expect(
      stripHtmlMarkup("<h1>Title</h1><p>Hello <em>world</em></p>").trim(),
    ).toBe("TitleHello world");
  });

  it("cannot expose a script tag assembled around removed markup", () => {
    const crafted = "<scr<script data-value='>'>ipt>alert(1)</script>";
    const text = stripHtmlMarkup(crafted);

    expect(text.toLowerCase()).not.toContain("<script");
    expect(text).toContain("alert(1)");
  });

  it("preserves less-than comparisons that are not markup", () => {
    expect(stripHtmlMarkup("Use 1 < 2 and 3 > 2.")).toBe(
      "Use 1 < 2 and 3 > 2.",
    );
  });
});
