import { validateWorkspaceCommand } from "@/lib/agent-workspace/command-executor"

const agent = (argv: string[]) => ({ argv, scope: "agent" as const })
const user = (argv: string[]) => ({ argv, scope: "user" as const })

describe("allowlist gaps closed from 2026-08-13 prod failures", () => {
  it("permits sheets +append (real gws helper, canonical twin already allowed)", () => {
    expect(() =>
      validateWorkspaceCommand(
        agent(["sheets", "+append", "--params", '{"spreadsheetId":"abc"}']),
        "hagelk@psd401.net"
      )
    ).not.toThrow()
  })

  it("holds sheets +append to the same agent-only boundary as its canonical twin", () => {
    // The two spellings of one operation must not disagree about impersonation.
    expect(() =>
      validateWorkspaceCommand(
        user(["sheets", "+append", "--params", '{"spreadsheetId":"abc"}']),
        "hagelk@psd401.net"
      )
    ).toThrow(/agent-owned/)
  })

  it("permits tasks tasklists insert (tasks tasks insert was already allowed)", () => {
    expect(() =>
      validateWorkspaceCommand(
        agent(["tasks", "tasklists", "insert", "--json", '{"title":"Farmer"}']),
        "hagelk@psd401.net"
      )
    ).not.toThrow()
  })

  // `drive +upload` was allowlisted and could never execute — see
  // refuseDriveUploadWithPublishGuidance in command-executor.ts. It is now
  // refused deliberately, on BOTH slots, with the route that does work.
  //
  // This test used to assert the opposite ("permits drive +upload on the agent
  // slot"), and passed, because it used the FLAG spelling. That is the whole
  // bug: operationTokens() folds leading positionals into the operation, so
  // only `--upload <path>` ever matched the allowlist entry, while the natural
  // `drive +upload <path>` did not — and neither form could reach a container
  // file from the web tier's empty mkdtemp anyway.
  it.each([
    ["agent", agent],
    ["user", user],
  ])("refuses drive +upload on the %s slot with the publish route", (
    _slot,
    invocation,
  ) => {
    for (const argv of [
      ["drive", "+upload", "--upload", "/opt/logo.png"],
      ["drive", "+upload", "/home/node/report.pdf"],
    ]) {
      expect(() =>
        validateWorkspaceCommand(invocation(argv), "hagelk@psd401.net")
      ).toThrow(/psd-publish-file/)
    }
  })

  it("still refuses the send helpers", () => {
    for (const verb of ["+send", "+reply", "+reply-all", "+forward"]) {
      expect(() =>
        validateWorkspaceCommand(
          agent(["gmail", verb, "--to", "a@b.c", "--body", "x"]),
          "hagelk@psd401.net"
        )
      ).toThrow()
    }
  })
})
