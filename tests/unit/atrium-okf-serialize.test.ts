/**
 * Unit tests for the pure OKF serialization layer (Issue #1103, Phase 8, §36.1).
 *
 * These need no database: they exercise the frontmatter emitter/parser, the
 * concept/index/log builders, and the mapping table (spec §36.1). Together they
 * assert acceptance criterion #1 (a v0.1-valid bundle: `type` frontmatter, mapped
 * fields) and the serialization half of #5 (round-trip preserves metadata + body).
 */

import {
  serializeFrontmatter,
  parseFrontmatter,
  serializeConceptFile,
  parseConceptFile,
} from "@/lib/content/okf/frontmatter";
import {
  buildConceptFile,
  buildIndexFile,
  buildLogFile,
  conceptFrontmatter,
  type ConceptSource,
} from "@/lib/content/okf/serialize";
import { OKF_FRONTMATTER_FIELDS } from "@/lib/content/okf/profile";

describe("OKF frontmatter (de)serialization", () => {
  it("emits type (required) + present optionals, omitting absent fields and empty tags", () => {
    const out = serializeFrontmatter({ type: "document", title: "Hi", tags: [] });
    expect(out).toContain('type: "document"');
    expect(out).toContain('title: "Hi"');
    // Empty tags array and every absent optional are omitted.
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("description:");
    expect(out).not.toContain("resource:");
    expect(out).not.toContain("timestamp:");
  });

  it("round-trips scalars, flow arrays, and escaped characters", () => {
    const fm = {
      type: "document",
      title: 'A "quoted" title: with colon',
      description: "line one\nline two",
      resource: "https://example.org/p/slug",
      tags: ["alpha", "b eta", "gamma"],
      timestamp: "2026-07-05T12:00:00.000Z",
    };
    const { frontmatter } = parseFrontmatter(serializeFrontmatter(fm));
    expect(frontmatter.type).toBe("document");
    expect(frontmatter.title).toBe('A "quoted" title: with colon');
    expect(frontmatter.description).toBe("line one\nline two");
    expect(frontmatter.resource).toBe("https://example.org/p/slug");
    expect(frontmatter.tags).toEqual(["alpha", "b eta", "gamma"]);
    expect(frontmatter.timestamp).toBe("2026-07-05T12:00:00.000Z");
  });

  it("round-trips a literal backslash sequence without corrupting the escape (single-pass unescape)", () => {
    // Title contains a literal backslash + n (NOT a newline) plus a quote — a
    // chained-.replace() unescaper would corrupt the `\\n` into `\` + newline.
    const fm = { type: "document", title: 'path\\name and a "q"', tags: ['a"b', "c\\d"] };
    const { frontmatter } = parseFrontmatter(serializeFrontmatter(fm));
    expect(frontmatter.title).toBe('path\\name and a "q"');
    expect(frontmatter.tags).toEqual(['a"b', "c\\d"]);
  });

  it("strips a leading BOM so a Windows-generated bundle still parses frontmatter", () => {
    const md = "\uFEFF---\ntype: document\ntitle: BOM Doc\n---\n\nBody";
    const concept = parseConceptFile(md);
    expect(concept.frontmatter.type).toBe("document");
    expect(concept.frontmatter.title).toBe("BOM Doc");
    expect(concept.body).toBe("Body");
  });

  it("tolerates other producers: unquoted scalars and block sequences", () => {
    const md = [
      "---",
      "type: document",
      "title: Bare Title",
      "tags:",
      "  - one",
      "  - two",
      "---",
      "",
      "Body text.",
    ].join("\n");
    const concept = parseConceptFile(md);
    expect(concept.frontmatter.type).toBe("document");
    expect(concept.frontmatter.title).toBe("Bare Title");
    expect(concept.frontmatter.tags).toEqual(["one", "two"]);
    expect(concept.body).toBe("Body text.");
  });

  it("defaults type to 'document' when a bundle omits the required field", () => {
    const concept = parseConceptFile("---\ntitle: No Type\n---\n\nBody");
    expect(concept.frontmatter.type).toBe("document");
  });

  it("treats a document with no frontmatter fence as pure body", () => {
    const { frontmatter, body } = parseFrontmatter("Just a body, no fence.");
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe("Just a body, no fence.");
  });

  it("pins the v0.1 field set", () => {
    expect(OKF_FRONTMATTER_FIELDS).toEqual([
      "type",
      "title",
      "description",
      "resource",
      "tags",
      "timestamp",
    ]);
  });
});

describe("OKF concept builder — mapping table (§36.1)", () => {
  const docSource: ConceptSource = {
    kind: "document",
    title: "Fractions Unit",
    summary: "A summary of the unit",
    tags: ["math", "grade-5"],
    updatedAt: "2026-07-01T00:00:00.000Z",
    resource: "https://example.org/p/fractions",
    bodyFormat: "markdown",
    body: "# Fractions\n\nContent here.",
  };

  it("maps kind→type, title, summary→description, tags, updatedAt→timestamp, resource", () => {
    const fm = conceptFrontmatter(docSource);
    expect(fm.type).toBe("document");
    expect(fm.title).toBe("Fractions Unit");
    expect(fm.description).toBe("A summary of the unit");
    expect(fm.tags).toEqual(["math", "grade-5"]);
    expect(fm.timestamp).toBe("2026-07-01T00:00:00.000Z");
    expect(fm.resource).toBe("https://example.org/p/fractions");
  });

  it("round-trips a document concept: metadata + body preserved", () => {
    const concept = parseConceptFile(buildConceptFile(docSource));
    expect(concept.frontmatter.type).toBe("document");
    expect(concept.frontmatter.title).toBe("Fractions Unit");
    expect(concept.frontmatter.description).toBe("A summary of the unit");
    expect(concept.frontmatter.tags).toEqual(["math", "grade-5"]);
    expect(concept.body.trim()).toBe("# Fractions\n\nContent here.");
  });

  it("fences an artifact body and escalates the fence past inner backticks", () => {
    const artifact: ConceptSource = {
      ...docSource,
      kind: "artifact",
      bodyFormat: "html",
      body: "<pre>```js\nconsole.log(1)\n```</pre>",
    };
    const file = buildConceptFile(artifact);
    // The concept declares the artifact type...
    expect(file).toContain('type: "artifact"');
    // ...and the fence is longer than the 3-backtick run inside the code.
    expect(file).toMatch(/````html\n/);
    expect(file).toContain("<pre>```js");
  });

  it("omits description/resource when the head version has none", () => {
    const fm = conceptFrontmatter({ ...docSource, summary: null, resource: null });
    expect(fm.description).toBeUndefined();
    expect(fm.resource).toBeUndefined();
  });
});

describe("OKF index.md + log.md builders", () => {
  it("builds an index.md linking child concepts and collections", () => {
    const index = buildIndexFile(
      "Mathematics",
      [{ title: "Fractions", href: "fractions.md" }],
      [{ title: "Geometry", href: "geometry/index.md" }]
    );
    expect(index).toContain('type: "index"');
    expect(index).toContain("# Mathematics");
    expect(index).toContain("[Fractions](fractions.md)");
    expect(index).toContain("[Geometry](geometry/index.md)");
  });

  it("builds a log.md change history newest-first from the version list", () => {
    const log = buildLogFile("Fractions Unit", [
      { versionNumber: 2, authorActor: "agent", summary: "revised", createdAt: "2026-07-02T00:00:00.000Z" },
      { versionNumber: 1, authorActor: "human", summary: null, createdAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(log).toContain("# Change history — Fractions Unit");
    expect(log).toContain("v2 · agent · 2026-07-02T00:00:00.000Z — revised");
    expect(log).toContain("v1 · human · 2026-07-01T00:00:00.000Z");
  });
});

describe("OKF concept file serialize/parse symmetry", () => {
  it("serializeConceptFile then parseConceptFile is lossless for the mapped fields", () => {
    const fm = {
      type: "document",
      title: "Symmetry",
      description: "d",
      tags: ["x"],
      timestamp: "2026-07-05T00:00:00.000Z",
    };
    const round = parseConceptFile(serializeConceptFile(fm, "The body."));
    expect(round.frontmatter).toMatchObject(fm);
    expect(round.body.trim()).toBe("The body.");
  });
});
