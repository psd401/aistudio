import { validateWorkspaceCommand } from "@/lib/agent-workspace/command-executor"

/**
 * Every Workspace capability gap found so far has had one shape: a sibling
 * spelling of an operation that was ALREADY allowed got missed, so a
 * capability the agent demonstrably had was refused in the form it actually
 * reached for.
 *
 *   gmail users drafts create        allowed -> gmail +draft                 missed
 *   sheets spreadsheets values append allowed -> sheets +append              missed
 *   drive files create               allowed -> drive +upload                missed
 *   tasks tasks insert               allowed -> tasks tasklists insert       missed
 *   sheets spreadsheets values update allowed -> ...values batchupdate       missed
 *
 * Each cost a user-visible failure and a separate build to fix, one at a time,
 * because nothing checked the allowlist for completeness — only that the
 * entries present were spelled correctly.
 *
 * These tests close that loop. They do not enumerate Google's API surface;
 * they assert that operations which are two spellings of the same act are
 * allowed or refused TOGETHER. Adding one half of a pair now fails here rather
 * than in production a week later.
 */

const CALLER = "hagelk@psd401.net"

function allows(argv: string[], scope: "agent" | "user" = "agent"): boolean {
  try {
    validateWorkspaceCommand({ scope, argv }, CALLER)
    return true
  } catch {
    return false
  }
}

/** A minimal well-formed invocation for an operation, so only the allowlist decides. */
function invocationFor(operation: string): string[] {
  const tokens = operation.split(" ")
  if (operation === "drive permissions create") {
    return [
      ...tokens,
      "--json",
      JSON.stringify({
        fileId: "f",
        type: "user",
        role: "reader",
        emailAddress: CALLER,
      }),
    ]
  }
  if (operation === "drive accessproposals resolve") {
    return [
      ...tokens,
      "--params",
      JSON.stringify({ fileId: "f", proposalId: "p" }),
      "--json",
      JSON.stringify({ action: "accept", role: "writer" }),
    ]
  }
  if (operation === "gmail +draft") {
    return ["gmail", "+draft", "--to", CALLER, "--subject", "x"]
  }
  return [...tokens, "--json", "{}"]
}

describe("bulk and singular spellings of one write travel together", () => {
  // `batchUpdate` writes the same cells `update` writes, to the same resource,
  // under the same scope rules. Allowing one without the other leaves the
  // agent doing N round trips where the API offers one call — which is exactly
  // how a workbook build stalled with an empty spreadsheet.
  const PAIRS: Array<[string, string]> = [
    ["sheets spreadsheets values update", "sheets spreadsheets values batchupdate"],
  ]

  it.each(PAIRS)("allows %s and %s together", (singular, bulk) => {
    expect(allows(invocationFor(singular))).toBe(allows(invocationFor(bulk)))
  })

  it("allows the bulk form the workbook build needs", () => {
    // Named explicitly: this is the one that stalled a report mid-build.
    expect(allows(invocationFor("sheets spreadsheets values batchupdate"))).toBe(true)
  })
})

describe("helper verbs and their canonical operations travel together", () => {
  // A helper verb is the spelling the model actually reaches for, because it
  // is what the skill documents. The canonical form is what gws implements.
  // Allowing one without the other means the capability exists but the
  // documented way to use it is refused — the `+draft` failure exactly.
  const HELPERS: Array<[string, string]> = [
    ["gmail +draft", "gmail users drafts create"],
    ["sheets +append", "sheets spreadsheets values append"],
    ["drive +upload", "drive files create"],
  ]

  it.each(HELPERS)("allows %s and %s together", (helper, canonical) => {
    expect(allows(invocationFor(helper))).toBe(allows(invocationFor(canonical)))
  })
})

describe("a resource family is usable end to end", () => {
  // Creating items in a list you cannot create is not a capability. This is
  // the `tasks tasklists insert` gap: five requests failed because the
  // container for the allowed operation could not be made.
  const FAMILIES: Array<[string, string]> = [
    ["tasks tasks insert", "tasks tasklists insert"],
    ["sheets spreadsheets values update", "sheets spreadsheets create"],
  ]

  it.each(FAMILIES)("allows %s alongside its container %s", (item, container) => {
    expect(allows(invocationFor(item))).toBe(true)
    expect(allows(invocationFor(container))).toBe(true)
  })
})

describe("the workbook build path is allowlisted end to end", () => {
  // The quartile report's final step, as one list. Any single refusal here
  // strands a finished dataset in an unshareable spreadsheet, which is what
  // happened on 2026-08-15 — data complete, Sheet empty.
  const WORKBOOK_BUILD = [
    "sheets spreadsheets create",
    "sheets spreadsheets batchupdate", // add the per-grade tabs
    "sheets spreadsheets values batchupdate", // fill them in one call
    "sheets spreadsheets values update", // per-range fallback
    "drive permissions create", // share it back to the caller
  ]

  it.each(WORKBOOK_BUILD)("allows %s", (operation) => {
    expect(allows(invocationFor(operation))).toBe(true)
  })
})

describe("closure does not widen the boundary", () => {
  // The pairs above must not become an argument for allowing deletes or sends
  // just because a sibling create is allowed. These stay refused.
  const STILL_REFUSED = [
    "drive files delete",
    "gmail users messages send",
    "sheets spreadsheets values clear",
    "drive permissions delete",
  ]

  it.each(STILL_REFUSED)("still refuses %s", (operation) => {
    expect(allows(invocationFor(operation))).toBe(false)
  })
})
