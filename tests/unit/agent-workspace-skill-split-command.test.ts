/**
 * The skill-side tokenizer must canonicalize a dotted method path the SAME way
 * the broker does (#1893).
 *
 * `splitCommand` in infra/agent-image/skills/psd-workspace/common.js produces
 * the argv that is sent to the broker AND the argv `gws` executes, and
 * `enforcePhase1Gates` matches against it. If the two sides disagree about
 * where one token ends and the next begins, a command passes the skill's gates
 * and is then refused by the broker with `operation_not_allowed` — the shape of
 * every workspace capability outage so far.
 *
 * Loaded by path rather than imported: this is a CommonJS module shipped into
 * the agent image, not application code.
 */

import { join } from "node:path"

const COMMON = join(
  process.cwd(),
  "infra/agent-image/skills/psd-workspace/common.js"
)

const { splitCommand } = require(COMMON) as {
  splitCommand: (command: string) => string[]
}

describe("psd-workspace splitCommand", () => {
  it("splits a dotted method path into positional tokens", () => {
    expect(splitCommand("sheets spreadsheets.values.batchUpdate")).toEqual([
      "sheets",
      "spreadsheets",
      "values",
      "batchUpdate",
    ])
  })

  it("splits a FULLY dotted method path", () => {
    expect(splitCommand("forms.forms.batchUpdate")).toEqual([
      "forms",
      "forms",
      "batchUpdate",
    ])
  })

  it("leaves an already-canonical command alone", () => {
    expect(splitCommand("gmail users messages attachments get")).toEqual([
      "gmail",
      "users",
      "messages",
      "attachments",
      "get",
    ])
  })

  it("never canonicalizes a flag value", () => {
    // A Drive query carries dots inside quotes; splitting it would corrupt the
    // payload both gates then judge.
    expect(
      splitCommand(`drive files list --params '{"q":"name contains 'a.b'"}'`)
    ).toEqual([
      "drive",
      "files",
      "list",
      "--params",
      `{"q":"name contains a.b"}`,
    ])
  })

  it("leaves a positional that is not a method path alone", () => {
    expect(splitCommand("drive +upload /home/node/report.pdf")).toEqual([
      "drive",
      "+upload",
      "/home/node/report.pdf",
    ])
  })

  it("keeps the helper verb intact", () => {
    expect(splitCommand("gmail +draft --to a@psd401.net")).toEqual([
      "gmail",
      "+draft",
      "--to",
      "a@psd401.net",
    ])
  })
})
