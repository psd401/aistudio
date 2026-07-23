/**
 * Unit tests for the Assistant Architect → SKILL.md serializer (Issue #925).
 * Pure functions, no I/O — these validate the canonical SKILL.md output.
 */

import {
  slugifySkillName,
  deriveAllowedTools,
  findInvalidAllowedToolEntries,
  buildSummary,
  serializeAssistantToSkill,
  isValidAllowedToolEntry,
  type SerializerAssistant,
} from "@/lib/skills/skill-serializer"

describe("slugifySkillName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifySkillName("My Cool Assistant")).toBe("my-cool-assistant")
  })

  it("strips non-alphanumeric and collapses hyphens", () => {
    expect(slugifySkillName("Foo!!! __ Bar??")).toBe("foo-bar")
  })

  it("trims leading/trailing hyphens", () => {
    expect(slugifySkillName("---Edge---")).toBe("edge")
  })

  it("strips accents", () => {
    expect(slugifySkillName("Résumé Helper")).toBe("resume-helper")
  })

  it("returns empty string for names with no usable characters", () => {
    expect(slugifySkillName("!!!")).toBe("")
  })

  it("truncates to 64 chars without trailing hyphen", () => {
    const long = "a".repeat(80)
    const slug = slugifySkillName(long)
    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug.endsWith("-")).toBe(false)
  })
})

describe("deriveAllowedTools", () => {
  it("returns empty for no prompts", () => {
    expect(deriveAllowedTools([])).toEqual([])
  })

  it("unions, dedupes, and sorts tools across prompts", () => {
    const tools = deriveAllowedTools([
      { name: "p1", content: "x", enabledTools: ["web-search", "code"] },
      { name: "p2", content: "y", enabledTools: ["code", "image-gen"] },
    ])
    expect(tools).toEqual(["code", "image-gen", "web-search"])
  })

  it("ignores empty/whitespace and non-array values", () => {
    const tools = deriveAllowedTools([
      { name: "p1", content: "x", enabledTools: ["  ", "code", ""] },
      { name: "p2", content: "y", enabledTools: null },
    ])
    expect(tools).toEqual(["code"])
  })

  // Epic #922 completion audit: the allowed-tools frontmatter line is emitted
  // UNQUOTED, so entries outside the strict charset (whitespace, newlines,
  // YAML-breaking chars) are dropped to prevent frontmatter key injection.
  it("drops entries with whitespace/newlines/YAML-breaking chars, keeping valid ones", () => {
    const tools = deriveAllowedTools([
      {
        name: "p1",
        content: "x",
        enabledTools: [
          "foo\nbar: baz",
          "a b",
          "tool@2",
          "tool@v0",
          "documents.create",
          "documents.create@v1",
          "connector:canva:design",
          "search_decisions",
        ],
      },
    ])
    expect(tools).toEqual([
      "connector:canva:design",
      "documents.create",
      "documents.create@v1",
      "search_decisions",
    ])
  })

  it("isValidAllowedToolEntry accepts only the strict identifier@vN grammar", () => {
    expect(isValidAllowedToolEntry("documents.create@v1")).toBe(true)
    expect(isValidAllowedToolEntry("connector:canva:design")).toBe(true)
    expect(isValidAllowedToolEntry("tool@v0")).toBe(false)
    expect(isValidAllowedToolEntry("a b")).toBe(false)
    expect(isValidAllowedToolEntry("foo\nbar: baz")).toBe(false)
  })
})

describe("findInvalidAllowedToolEntries", () => {
  it("returns exactly the entries deriveAllowedTools would drop, deduped", () => {
    const invalid = findInvalidAllowedToolEntries([
      {
        name: "p1",
        content: "x",
        enabledTools: ["a b", "tool@2", "documents.create"],
      },
      {
        name: "p2",
        content: "y",
        enabledTools: ["a b", "tool@v0", "search_decisions"],
      },
    ])
    expect(invalid).toEqual(["a b", "tool@2", "tool@v0"])
  })

  it("returns empty when every entry is valid (or blank)", () => {
    expect(
      findInvalidAllowedToolEntries([
        { name: "p1", content: "x", enabledTools: ["documents.create", "  ", ""] },
        { name: "p2", content: "y", enabledTools: null },
      ])
    ).toEqual([])
  })

  it("returns empty for no prompts", () => {
    expect(findInvalidAllowedToolEntries([])).toEqual([])
  })
})

describe("buildSummary", () => {
  it("uses the description when present", () => {
    expect(
      buildSummary({ name: "A", description: "Does a thing.", prompts: [] })
    ).toBe("Does a thing.")
  })

  it("collapses newlines", () => {
    expect(
      buildSummary({ name: "A", description: "Line one\n  Line two", prompts: [] })
    ).toBe("Line one Line two")
  })

  it("falls back when no description", () => {
    expect(buildSummary({ name: "Helper", description: null })).toContain(
      "Helper"
    )
  })

  it("truncates over 200 chars with an ellipsis", () => {
    const summary = buildSummary({
      name: "A",
      description: "word ".repeat(60), // 300 chars
    })
    expect(summary.length).toBeLessThanOrEqual(200)
    expect(summary.endsWith("…")).toBe(true)
  })
})

describe("serializeAssistantToSkill", () => {
  const base: SerializerAssistant = {
    name: "Lesson Planner",
    description: "Generates differentiated lesson plans for K-12 teachers.",
    inputFields: [
      { name: "grade", label: "Grade level", fieldType: "short_text" },
      { name: "topic", label: null, fieldType: "long_text" },
    ],
    prompts: [
      {
        name: "Outline",
        content: "Create an outline for ${topic}.",
        systemContext: "You are a curriculum designer.",
        position: 0,
        enabledTools: ["web-search"],
      },
      {
        name: "Expand",
        content: "Expand each section.",
        position: 1,
        enabledTools: ["code"],
      },
    ],
  }

  it("produces valid frontmatter delimited by ---", () => {
    const { skillMd } = serializeAssistantToSkill(base)
    expect(skillMd.startsWith("---\n")).toBe(true)
    // closing delimiter present
    expect(skillMd).toMatch(/\n---\n/)
  })

  it("includes name slug, summary, description, and sorted allowed-tools", () => {
    const result = serializeAssistantToSkill(base)
    expect(result.slug).toBe("lesson-planner")
    expect(result.summary).toBe(
      "Generates differentiated lesson plans for K-12 teachers."
    )
    expect(result.allowedTools).toEqual(["code", "web-search"])
    expect(result.skillMd).toContain("name: lesson-planner")
    expect(result.skillMd).toContain("allowed-tools: code, web-search")
  })

  it("renders input fields and prompt steps in the body", () => {
    const { skillMd } = serializeAssistantToSkill(base)
    expect(skillMd).toContain("| `grade` | Grade level | short_text |")
    expect(skillMd).toContain("### Step 1: Outline")
    expect(skillMd).toContain("### Step 2: Expand")
    expect(skillMd).toContain("You are a curriculum designer.")
  })

  it("orders prompt steps by position", () => {
    const out = serializeAssistantToSkill({
      ...base,
      prompts: [
        { name: "Second", content: "b", position: 2, enabledTools: [] },
        { name: "First", content: "a", position: 1, enabledTools: [] },
      ],
    })
    const firstIdx = out.skillMd.indexOf("First")
    const secondIdx = out.skillMd.indexOf("Second")
    expect(firstIdx).toBeGreaterThan(-1)
    expect(firstIdx).toBeLessThan(secondIdx)
  })

  it("omits allowed-tools key when there are no tools", () => {
    const { skillMd } = serializeAssistantToSkill({
      ...base,
      prompts: [{ name: "P", content: "x", enabledTools: [] }],
    })
    expect(skillMd).not.toContain("allowed-tools:")
  })

  it("quotes summary values that would break YAML", () => {
    const { skillMd } = serializeAssistantToSkill({
      name: "Edge",
      description: "key: value with a colon",
      prompts: [],
    })
    expect(skillMd).toContain('summary: "key: value with a colon"')
  })

  it("handles empty input fields gracefully", () => {
    const { skillMd } = serializeAssistantToSkill({
      name: "NoInputs",
      description: "x",
      inputFields: [],
      prompts: [{ name: "P", content: "y", enabledTools: [] }],
    })
    expect(skillMd).toContain("_This assistant takes no structured inputs._")
  })

  it("throws for names that cannot produce a slug", () => {
    expect(() =>
      serializeAssistantToSkill({ name: "!!!", description: "x", prompts: [] })
    ).toThrow(/valid skill slug/)
  })

  it("a hostile allowed-tools entry cannot inject a frontmatter key", () => {
    const { skillMd, allowedTools } = serializeAssistantToSkill({
      name: "Hostile",
      description: "x",
      prompts: [
        {
          name: "P",
          content: "y",
          enabledTools: ["x\ninjected: true", "safe.tool"],
        },
      ],
    })
    // The hostile entry is dropped from the derived pin entirely.
    expect(allowedTools).toEqual(["safe.tool"])

    // The frontmatter block (between the --- delimiters) must contain no line
    // starting "injected:" — the newline in the entry may not smuggle a key in.
    const frontmatter = skillMd.split(/^---$/m)[1]
    expect(frontmatter).toContain("allowed-tools: safe.tool")
    expect(/^injected:/m.test(frontmatter)).toBe(false)
  })
})
