/**
 * How the broker reads the OPERATION out of an argv (#1893).
 *
 * Two parsing defects refused valid work for about 21 users in October 2026:
 *
 *   1. A dotted method path arrived as ONE token. `sheets
 *      spreadsheets.values.batchUpdate` was judged as the action
 *      `spreadsheets.values.batchupdate`, which is in no allowlist, and a fully
 *      dotted `forms.forms.batchUpdate` could not even name a service and an
 *      operation — while both spaced twins were allowed. SKILL.md taught the
 *      dotted spelling, so the documented form of an allowed write was refused.
 *   2. The operation was cut at FOUR positionals. `gmail users messages
 *      attachments get` was evaluated as `… attachments` — not a read — and
 *      refused; and an allowlisted four-token prefix silently granted every
 *      action beneath it, which is a containment defect, not just a gap.
 *
 * Both halves are security-relevant in BOTH directions, so every test here has
 * a matching boundary test: a spelling that is accepted must be accepted as the
 * same operation, and a refusal must survive being respelled.
 */

import {
  canonicalizeOperationPath,
  validateWorkspaceCommand,
  workspaceOperation,
} from "@/lib/agent-workspace/command-executor"

const CALLER = "hagelk@psd401.net"

function allows(argv: string[], scope: "agent" | "user" = "agent"): boolean {
  try {
    validateWorkspaceCommand({ scope, argv }, CALLER)
    return true
  } catch {
    return false
  }
}

describe("dotted and spaced spellings are one operation", () => {
  // {dotted, spaced} × {allowed write, refused write, read}. The assertion is
  // EQUALITY of verdict, not "allowed": a respelling must never change the
  // answer, in either direction.
  const CASES: Array<{
    name: string
    spaced: string[]
    dotted: string[]
    expected: boolean
    scope: "agent" | "user"
  }> = [
    {
      name: "an allowed write",
      spaced: ["sheets", "spreadsheets", "values", "batchUpdate"],
      dotted: ["sheets", "spreadsheets.values.batchUpdate"],
      expected: true,
      scope: "agent",
    },
    {
      name: "a refused write",
      spaced: ["gmail", "users", "messages", "send"],
      dotted: ["gmail.users.messages.send"],
      expected: false,
      scope: "user",
    },
    {
      name: "a read",
      spaced: ["drive", "files", "list"],
      dotted: ["drive.files.list"],
      expected: true,
      scope: "user",
    },
  ]

  it.each(CASES)(
    "gives $name the same verdict either way",
    ({ spaced, dotted, expected, scope }) => {
      const argv = ["--json", "{}"]
      expect(allows([...spaced, ...argv], scope)).toBe(expected)
      expect(allows([...dotted, ...argv], scope)).toBe(expected)
    }
  )

  it("resolves a FULLY dotted method rather than failing to parse it", () => {
    // `forms.forms.batchUpdate` as a single token used to throw "must name a
    // service and operation" — the command never reached the allowlist at all.
    expect(
      allows(
        ["forms.forms.batchUpdate", "--params", '{"formId":"f"}', "--json", "{}"],
        "agent"
      )
    ).toBe(true)
    expect(workspaceOperation(["forms.forms.batchUpdate"])).toBe(
      "forms forms batchupdate"
    )
  })

  it("canonicalizes the OPERATION only, never a flag value", () => {
    // A `--params` object, a Drive query or a filesystem path legitimately
    // contains dots. Splitting one would corrupt the payload the gates just
    // judged, so only the leading positional run is canonicalized.
    expect(
      canonicalizeOperationPath([
        "drive.files.list",
        "--params",
        '{"q":"name contains \'a.b\'"}',
      ])
    ).toEqual(["drive", "files", "list", "--params", '{"q":"name contains \'a.b\'"}'])
  })

  it("preserves the camelCase gws expects in the executed argv", () => {
    // The validator lowercases to match the allowlist; the EXECUTED argv must
    // keep the method's own case or the CLI does not recognise it.
    expect(
      canonicalizeOperationPath(["sheets", "spreadsheets.values.batchUpdate"])
    ).toEqual(["sheets", "spreadsheets", "values", "batchUpdate"])
  })

  it("does not tear apart a positional that merely contains dots", () => {
    // A filesystem path is not a method path. `drive +upload` is refused
    // either way, but the argv it is refused with must still be the caller's.
    expect(
      canonicalizeOperationPath(["drive", "+upload", "/home/node/report.pdf"])
    ).toEqual(["drive", "+upload", "/home/node/report.pdf"])
  })

  it("cannot use the dotted form to smuggle a mutation past a read", () => {
    // The read branch screens earlier mutating tokens. Canonicalizing BEFORE
    // that screen is what keeps the dotted spelling from hiding one.
    expect(allows(["drive.files.delete.list"], "user")).toBe(false)
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv: ["drive.files.delete.list"] }, CALLER)
    ).toThrow(/mutation/i)
  })

  it.each([
    ["drive", "accessproposals", "resolve", "get"],
    ["drive", "accessproposals", "resolve", "list"],
    ["sheets", "spreadsheets", "values", "append", "get"],
    ["drive.accessproposals.resolve.get"],
  ])("cannot reach an allowlisted write's path with a trailing read: %j", (...argv) => {
    for (const scope of ["agent", "user"] as const) {
      expect(() => validateWorkspaceCommand({ scope, argv }, CALLER)).toThrow(/mutation/i)
    }
  })
})

describe("the operation is the WHOLE positional path", () => {
  it("classifies a five-token read by its real action", () => {
    // Cut at four tokens this was `gmail users messages attachments`, which is
    // not a read action and is in no write allowlist — so reading an email
    // attachment was refused outright.
    expect(
      allows(
        [
          "gmail",
          "users",
          "messages",
          "attachments",
          "get",
          "--params",
          '{"userId":"me","messageId":"m","id":"a"}',
        ],
        "user"
      )
    ).toBe(true)
  })

  it("checks a five-token write against its full path", () => {
    expect(
      allows(
        ["gmail", "users", "settings", "filters", "create", "--json", "{}"],
        "user"
      )
    ).toBe(true)
  })

  it("refuses a fifth token the allowlist does not name", () => {
    // The containment half. A four-token prefix entry used to grant every
    // action beneath the resource, invented tokens included.
    expect(
      allows(
        ["gmail", "users", "settings", "filters", "totally-made-up"],
        "user"
      )
    ).toBe(false)
  })

  it("reports the full path in the diagnostic operation", () => {
    // The refusal message and the completion log both read this. Truncated,
    // they named an operation that was not the one judged.
    expect(
      workspaceOperation(["gmail", "users", "settings", "filters", "delete"])
    ).toBe("gmail users settings filters delete")
  })

  it("still bounds the diagnostic operation", () => {
    // Removing the positional cutoff must not remove the LENGTH cutoff: the
    // operation string goes into logs and error bodies.
    expect(workspaceOperation(["X".repeat(1_000_000)])).toBe(
      "<operation-too-long>"
    )
  })
})

describe("reads that were missing from the read classification", () => {
  it("allows the bulk Sheet read", () => {
    // `batchGet` reads exactly what `get` reads. It was refused only because
    // it is spelled differently.
    expect(
      allows(
        [
          "sheets",
          "spreadsheets",
          "values",
          "batchGet",
          "--params",
          '{"spreadsheetId":"s","ranges":["A1:B2"]}',
        ],
        "user"
      )
    ).toBe(true)
  })

  it("allows the free/busy lookup", () => {
    expect(allows(["calendar", "freebusy", "query", "--json", "{}"], "user")).toBe(
      true
    )
  })

  it("does not turn `query` into a read verb everywhere", () => {
    // `calendar freebusy query` is named as a whole operation precisely so
    // that a `query` elsewhere in Google's surface stays a write.
    expect(allows(["sheets", "spreadsheets", "query", "--json", "{}"], "agent")).toBe(
      false
    )
  })

  it("does not let the new reads carry a mutation", () => {
    expect(allows(["calendar", "events", "delete", "freebusy", "query"], "user")).toBe(
      false
    )
    expect(
      allows(["sheets", "spreadsheets", "values", "update", "batchGet"], "user")
    ).toBe(false)
  })
})
