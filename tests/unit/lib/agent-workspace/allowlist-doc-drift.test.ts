import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateWorkspaceCommand } from "@/lib/agent-workspace/command-executor"

/**
 * Every Workspace operation shown as a worked example in psd-workspace/SKILL.md
 * must be reachable through the broker validator.
 *
 * Seven operations drifted out of the allowlist in the 2026-08-03..05 window
 * alone — `drive permissions create`, the params-only move, `gmail +draft`,
 * `drive accessproposals resolve`, `forms forms create`, `gmail users labels
 * create` and `drive comments create`. Each was documented, or API-enabled, or
 * both; each was refused with `operation_not_allowed`; and each surfaced only
 * when a real user hit it, because nothing compared the docs to the allowlist.
 *
 * This closes that loop: the SKILL.md examples ARE the contract the model is
 * taught, so a documented operation the broker refuses is a defect in one of
 * the two, and the test fails until they agree.
 */
const SKILL_MD = join(
  process.cwd(),
  "infra/agent-image/skills/psd-workspace/SKILL.md"
)

/**
 * Every `gws <service>.<resource>.<action>` invocation the doc shows.
 *
 * Deliberately one flat, bounded pattern: an earlier version nested quantifiers
 * to parse space- and dot-separated forms together and tripped
 * `security/detect-unsafe-regex`. The dotted form is what the examples use, and
 * this only guards that the scrape still finds something.
 */
function documentedOperations(): string[] {
  const md = readFileSync(SKILL_MD, "utf8")
  const found = new Set<string>()
  // One flat character run, split in JS. A `{1,20}` nested inside a `{1,3}`
  // is star-height 2 and `security/detect-unsafe-regex` rejects it however
  // tight the bounds — the same shape the chat-chart email pattern hit.
  for (const match of md.matchAll(/gws ([a-z][a-z.]{1,60})/g)) {
    const parts = match[1]!.split(".").filter(Boolean)
    if (parts.length >= 2 && parts.length <= 4) {
      found.add(parts.join(" ").toLowerCase())
    }
  }
  return [...found]
}

describe("SKILL.md examples stay reachable through the broker", () => {
  // Operations the skill documents with a concrete, copyable invocation. Kept
  // explicit rather than scraped loosely: a scraper wide enough to catch every
  // shape also catches prose, and a test that cries wolf gets muted.
  const DOCUMENTED_WORKED_EXAMPLES: Array<{ argv: string[]; scope: "agent" | "user" }> = [
    { scope: "user", argv: ["gmail", "+draft", "--to", "a@psd401.net", "--subject", "x"] },
    { scope: "user", argv: ["gmail", "users", "labels", "create", "--json", '{"name":"Digested"}'] },
    { scope: "user", argv: ["drive", "files", "update", "--params", '{"fileId":"f","addParents":"p"}'] },
    { scope: "user", argv: ["drive", "files", "update", "--params", '{"fileId":"f"}', "--json", '{"name":"n"}'] },
    { scope: "agent", argv: ["docs", "documents", "create", "--json", '{"title":"t"}'] },
    { scope: "agent", argv: ["sheets", "spreadsheets", "create", "--json", "{}"] },
    { scope: "agent", argv: ["slides", "presentations", "create", "--json", "{}"] },
    { scope: "agent", argv: ["forms", "forms", "create", "--json", "{}"] },
    { scope: "agent", argv: ["drive", "comments", "create", "--json", '{"content":"c"}'] },
    {
      scope: "agent",
      argv: [
        "drive", "permissions", "create",
        "--json",
        '{"fileId":"f","type":"user","role":"reader","emailAddress":"a@psd401.net"}',
      ],
    },
    {
      scope: "agent",
      argv: [
        "drive", "accessproposals", "resolve",
        "--params", '{"fileId":"f","proposalId":"p"}',
        "--json", '{"action":"accept","role":"writer"}',
      ],
    },
  ]

  it.each(DOCUMENTED_WORKED_EXAMPLES)(
    "allows the documented $scope-slot example: $argv",
    ({ argv, scope }) => {
      expect(() =>
        validateWorkspaceCommand({ scope, argv }, "a@psd401.net")
      ).not.toThrow()
    }
  )

  it("finds the documented operations it claims to cover", () => {
    // Guards the guard: if SKILL.md is restructured so the scrape returns
    // nothing, this suite would silently pass while covering zero operations.
    const ops = documentedOperations()
    // Named rather than counted: a count drifts silently as the doc is edited,
    // and these are precisely the operations that were documented-but-refused.
    for (const required of [
      "drive permissions create",
      "drive accessproposals resolve",
      "drive comments create",
      "forms forms create",
      "gmail users labels create",
    ]) {
      expect(ops).toContain(required)
    }
  })

  it("still refuses everything the docs describe as forbidden", () => {
    for (const forbidden of [
      ["gmail", "users", "messages", "send"],
      ["gmail", "+send", "--to", "a@psd401.net"],
      ["drive", "files", "delete", "--params", '{"fileId":"f"}'],
      ["calendar", "events", "delete"],
    ]) {
      expect(() =>
        validateWorkspaceCommand({ scope: "agent", argv: forbidden }, "a@psd401.net")
      ).toThrow()
    }
  })
})
