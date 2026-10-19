/**
 * Nexus generated-document markdown smoke test (Bun) — Issue #1898.
 *
 * Covers the markdown handling that makes a generated file readable:
 *   - `lib/ai/markdown-blocks.ts` — markdown parsed into the neutral block IR,
 *     and the IR turned into slide specs.
 *   - `lib/ai/document-docx-builder.ts` — the IR rendered to real Word
 *     structures, asserted against the OOXML inside the packed .docx.
 *
 * Why Bun, not jest: both modules import `marked`, which is pure ESM. next/jest
 * overrides `transformIgnorePatterns`, so `marked` cannot be transformed and any
 * jest suite that loads these modules dies with "Unexpected token 'export'" —
 * the same constraint `jest.config.js` documents for the unified/remark stack.
 * The jest suites therefore mock these two modules and own the orchestration
 * (S3 keys, filenames, cover slide, result shape); this file owns the semantics.
 *
 * Run: `bun run tests/smoke/nexus-document-markdown.smoke.ts`
 */

import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  markdownToSlides,
  normalizeSlideDelimiters,
  parseMarkdownBlocks,
  runsToPlainText,
  type MarkdownBlock,
} from "@/lib/ai/markdown-blocks";
import {
  buildDocxDocument,
  packDocx,
} from "@/lib/ai/document-docx-builder";

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((error: unknown) => {
      failures.push(name);
      console.error(`  ✗ ${name}`);
      console.error(error instanceof Error ? error.message : String(error));
    });
}

function kinds(blocks: MarkdownBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

/** Render markdown to a .docx and return one of its parts as a string. */
async function docxPart(
  title: string | undefined,
  markdown: string,
  part = "word/document.xml"
): Promise<string> {
  const buffer = await packDocx(buildDocxDocument(title, markdown));
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(part);
  assert.ok(entry, `packed .docx contains ${part}`);
  return entry.async("string");
}

function documentXml(
  title: string | undefined,
  markdown: string
): Promise<string> {
  return docxPart(title, markdown);
}

/**
 * Whether a `<w:t>` run in the document carries exactly this text. Matching the
 * element form is what proves the text is a Word run rather than a substring of
 * some attribute value. `docx` emits the `xml:space` form for ordinary runs, so
 * both spellings are accepted; a plain `includes` would pass on either.
 */
function hasRunText(xml: string, text: string): boolean {
  return (
    xml.includes(`<w:t xml:space="preserve">${text}</w:t>`) ||
    xml.includes(`<w:t>${text}</w:t>`)
  );
}

/** The body only — excludes the `<?xml ... ?>` declaration and the namespaces. */
function bodyOf(xml: string): string {
  const start = xml.indexOf("<w:body>");
  const end = xml.indexOf("</w:body>");
  assert.ok(start >= 0 && end > start, "document has a body");
  return xml.slice(start, end);
}

// ---------------------------------------------------------------------------
// Block IR
// ---------------------------------------------------------------------------

await check("parses headings, paragraphs, lists, tables, code and rules", () => {
  const blocks = parseMarkdownBlocks(
    [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "## Section",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> quoted",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "***",
      "",
    ].join("\n")
  );
  assert.deepEqual(kinds(blocks), [
    "heading",
    "paragraph",
    "heading",
    "listItem",
    "listItem",
    "listItem",
    "listItem",
    "table",
    "quote",
    "code",
    "rule",
  ]);
  const [h1] = blocks;
  assert.equal(h1.kind === "heading" && h1.level, 1);
  const unordered = blocks.filter(
    (b): b is Extract<MarkdownBlock, { kind: "listItem" }> =>
      b.kind === "listItem"
  );
  assert.equal(unordered[0].ordered, false, "dash list is unordered");
  assert.equal(unordered[2].ordered, true, "1. list is ordered");
});

await check("captures bold, italic and inline code as styled runs", () => {
  const blocks = parseMarkdownBlocks(
    "Plain **bold** and *italic* and `code` here."
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
  const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
  assert.equal(runsToPlainText(runs), "Plain bold and italic and code here.");
  assert.ok(
    runs.some((r) => r.text === "bold" && r.bold === true),
    "bold run flagged"
  );
  assert.ok(
    runs.some((r) => r.text === "italic" && r.italic === true),
    "italic run flagged"
  );
  assert.ok(
    runs.some((r) => r.text === "code" && r.code === true),
    "code run flagged"
  );
});

await check("composes nested emphasis instead of losing the outer style", () => {
  const blocks = parseMarkdownBlocks("**bold *and italic***");
  const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
  const both = runs.find((r) => r.text.includes("and italic"));
  assert.ok(both, "nested run present");
  assert.equal(both.bold, true);
  assert.equal(both.italic, true);
});

await check("tracks nested list depth", () => {
  const blocks = parseMarkdownBlocks("- top\n  - nested\n    - deeper");
  const items = blocks.filter(
    (b): b is Extract<MarkdownBlock, { kind: "listItem" }> =>
      b.kind === "listItem"
  );
  assert.deepEqual(
    items.map((i) => i.level),
    [0, 1, 2]
  );
});

await check("keeps a link's text and its target", () => {
  const blocks = parseMarkdownBlocks("See [the policy](https://example.org/p).");
  const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
  const text = runsToPlainText(runs);
  assert.ok(text.includes("the policy"), "link label kept");
  assert.ok(text.includes("https://example.org/p"), "link target kept");
});

await check("returns no blocks for empty input and never throws", () => {
  assert.deepEqual(parseMarkdownBlocks(""), []);
  assert.deepEqual(parseMarkdownBlocks("   \n\n  "), []);
});

// ---------------------------------------------------------------------------
// DOCX rendering
// ---------------------------------------------------------------------------

await check("DOCX renders headings as Word heading styles, not literal '##'", async () => {
  const xml = await documentXml(undefined, "# Big\n\n## Smaller\n\nBody.");
  assert.ok(xml.includes('w:val="Heading1"'), "H1 uses the Heading1 style");
  assert.ok(xml.includes('w:val="Heading2"'), "H2 uses the Heading2 style");
  assert.ok(!xml.includes("## Smaller"), "no raw markdown on the page");
  assert.ok(hasRunText(xml, "Smaller"), "heading text present");
});

await check("DOCX renders a title as the Word Title style", async () => {
  const xml = await documentXml("Staff Newsletter", "Body.");
  assert.ok(xml.includes('w:val="Title"'), "title paragraph uses Title style");
  assert.ok(xml.includes("Staff Newsletter"));
});

await check("DOCX renders bold and italic as run properties", async () => {
  const xml = await documentXml(undefined, "A **bold** and *italic* line.");
  assert.ok(/<w:b\b/.test(xml), "bold run property emitted");
  assert.ok(/<w:i\b/.test(xml), "italic run property emitted");
  assert.ok(!xml.includes("**bold**"), "markdown asterisks not printed");
});

await check("DOCX renders a bulleted list as real bullets", async () => {
  const xml = await documentXml(undefined, "- alpha\n- beta");
  // docx emits bullets via the ListParagraph style + numbering properties.
  assert.ok(xml.includes("<w:numPr>"), "list numbering properties emitted");
  assert.ok(xml.includes('w:val="ListParagraph"'), "list paragraph style applied");
  assert.ok(hasRunText(xml, "alpha"), "item text present");
  assert.ok(!hasRunText(xml, "- alpha"), "dash not printed as text");

  // The bullet glyph must be defined, or Word renders the items unmarked.
  const numbering = await docxPart(
    undefined,
    "- alpha\n- beta",
    "word/numbering.xml"
  );
  assert.ok(
    numbering.includes('w:numFmt w:val="bullet"'),
    "bullet level format defined"
  );
});

await check("DOCX renders a numbered list with an ordered numbering reference", async () => {
  const xml = await documentXml(undefined, "1. first\n2. second");
  assert.ok(xml.includes("<w:numPr>"), "numbering properties emitted");
  assert.ok(hasRunText(xml, "first"), "item text present");
  assert.ok(!hasRunText(xml, "1. first"), "digits not printed as text");

  // The ordered numbering definition must actually exist, or Word shows the
  // items unnumbered.
  const numbering = await docxPart(
    undefined,
    "1. first\n2. second",
    "word/numbering.xml"
  );
  assert.ok(
    numbering.includes('w:numFmt w:val="decimal"'),
    "decimal level format defined for ordered lists"
  );
  assert.ok(
    numbering.includes('w:lvlText w:val="%1."'),
    "first ordered level renders as '1.'"
  );

  // A bulleted list and a numbered list must not share a numbering id, or the
  // bullets inherit the ordered format.
  const mixed = await documentXml(undefined, "- alpha\n\n1. first");
  const numIds = [...mixed.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(
    (m) => m[1]
  );
  assert.equal(
    new Set(numIds).size,
    2,
    "bulleted and ordered lists use distinct numIds"
  );
});

await check("DOCX renders a markdown table as a Word table with a header row", async () => {
  const xml = await documentXml(
    undefined,
    "| Name | Role |\n|---|---|\n| Ada | Lead |\n| Grace | Eng |"
  );
  assert.ok(xml.includes("<w:tbl>"), "table element emitted");
  assert.ok(xml.includes("<w:tblHeader"), "header row flagged");
  for (const cell of ["Name", "Role", "Ada", "Lead", "Grace", "Eng"]) {
    assert.ok(hasRunText(xml, cell), `cell ${cell} present`);
  }
  assert.ok(!xml.includes("|---|"), "table pipes not printed as text");
  assert.equal(
    [...xml.matchAll(/<w:tr>/g)].length,
    3,
    "one header row plus two data rows"
  );
});

await check("DOCX keeps non-ASCII text intact (OOXML is UTF-8)", async () => {
  const xml = await documentXml(
    "Café — Update",
    "José Núñez said “ready” – pages 3–5."
  );
  assert.ok(xml.includes("José Núñez"), "accented name intact");
  assert.ok(xml.includes("“ready”"), "curly quotes intact");
  assert.ok(xml.includes("3–5"), "en dash intact");
  // The `<?xml ... ?>` declaration contains "?", so check the body only.
  assert.ok(!bodyOf(xml).includes("?"), "nothing replaced with a question mark");
});

await check("DOCX produces a valid body for empty content", async () => {
  const xml = await documentXml(undefined, "");
  assert.ok(xml.includes("<w:body>"), "body element present");
});

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

await check("each '##' heading starts a slide whose bullets are the lines under it", () => {
  const slides = markdownToSlides(
    [
      "## Why it matters",
      "",
      "- First point",
      "- Second point",
      "",
      "## What we do next",
      "",
      "Run the pilot.",
      "",
    ].join("\n")
  );
  assert.deepEqual(slides, [
    { title: "Why it matters", bullets: ["First point", "Second point"] },
    { title: "What we do next", bullets: ["Run the pilot."] },
  ]);
});

await check("the long-advertised '---' delimiter still splits slides", () => {
  // Written exactly as `documents.create` documents it: no blank line before
  // the delimiter, which markdown would otherwise read as a setext heading.
  const slides = markdownToSlides(
    "Slide one\nbody text\n---\nSlide two\nmore body"
  );
  assert.deepEqual(slides, [
    { title: "Slide one", bullets: ["body text"] },
    { title: "Slide two", bullets: ["more body"] },
  ]);
});

await check("normalizeSlideDelimiters only inserts a break before a lone '---'", () => {
  assert.equal(normalizeSlideDelimiters("a\n---\nb"), "a\n\n---\nb");
  // Already separated: left alone (no double blank line).
  assert.equal(normalizeSlideDelimiters("a\n\n---\nb"), "a\n\n---\nb");
  // Not a lone delimiter: a table rule must not be touched.
  assert.equal(normalizeSlideDelimiters("| a |\n|---|\n| 1 |"), "| a |\n|---|\n| 1 |");
});

await check("a slide with no heading promotes its first line to the title", () => {
  const slides = markdownToSlides("Just one line\nand a detail");
  assert.deepEqual(slides, [
    { title: "Just one line", bullets: ["and a detail"] },
  ]);
});

await check("a sub-heading under a title-less slide becomes that slide's title", () => {
  const slides = markdownToSlides("# Deck title\n\n## First slide\n\n- point");
  assert.deepEqual(slides, [
    { title: "Deck title", bullets: [] },
    { title: "First slide", bullets: ["point"] },
  ]);
});

await check("table rows and code lines become bullets rather than being dropped", () => {
  const slides = markdownToSlides(
    "## Numbers\n\n| Year | Count |\n|---|---|\n| 2025 | 10 |"
  );
  assert.equal(slides.length, 1);
  assert.deepEqual(slides[0].bullets, ["2025 — 10"]);
});

await check("empty markdown yields no slides (the caller adds a placeholder)", () => {
  assert.deepEqual(markdownToSlides(""), []);
  assert.deepEqual(markdownToSlides("   "), []);
});

await check("caps slides and bullets so a runaway body cannot blow out the layout", () => {
  const many = Array.from({ length: 150 }, (_, i) => `## Slide ${i}`).join(
    "\n\n"
  );
  assert.equal(markdownToSlides(many).length, 100);

  const manyBullets = [
    "## One slide",
    "",
    ...Array.from({ length: 40 }, (_, i) => `- point ${i}`),
  ].join("\n");
  assert.equal(markdownToSlides(manyBullets)[0].bullets.length, 12);
});

if (failures.length > 0) {
  console.error(
    `\nnexus-document-markdown smoke: ${failures.length} FAILED (${failures.join(", ")})`
  );
  process.exit(1);
}
console.log(`\nnexus-document-markdown smoke: ${passed} checks passed`);
