import * as fs from "node:fs"
import * as path from "node:path"
import { parseBundledSkillFrontmatter } from "@/infra/lib/bundled-skill-manifest"

describe("bundled skill manifest frontmatter", () => {
  it("persists the conversation coach Read-only pin", () => {
    const raw = fs.readFileSync(
      path.join(
        process.cwd(),
        "infra",
        "agent-image",
        "skills",
        "psd-conversation-coach",
        "SKILL.md"
      ),
      "utf8"
    )

    expect(parseBundledSkillFrontmatter(raw)).toMatchObject({
      name: "psd-conversation-coach",
      allowedTools: ["Read"],
    })
  })

  it("accepts inline and YAML-list allowed-tools forms", () => {
    expect(
      parseBundledSkillFrontmatter(
        [
          "---",
          "name: inline-skill",
          "summary: Inline",
          "allowed-tools: Read, documents.create@v1",
          "---",
        ].join("\n")
      )?.allowedTools
    ).toEqual(["Read", "documents.create@v1"])

    expect(
      parseBundledSkillFrontmatter(
        [
          "---",
          "name: list-skill",
          "summary: List",
          "allowed-tools:",
          "  - Read",
          "  - documents.create@v1",
          "description: A list-form skill",
          "---",
        ].join("\r\n")
      )
    ).toEqual({
      name: "list-skill",
      summary: "List",
      description: "A list-form skill",
      allowedTools: ["Read", "documents.create@v1"],
    })
  })

  it("rejects missing frontmatter and missing names", () => {
    expect(parseBundledSkillFrontmatter("# no frontmatter")).toBeNull()
    expect(
      parseBundledSkillFrontmatter(
        ["---", "summary: Missing name", "---"].join("\n")
      )
    ).toBeNull()
  })
})
