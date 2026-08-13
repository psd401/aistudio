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

  it("permits drive +upload on the agent slot", () => {
    expect(() =>
      validateWorkspaceCommand(
        agent(["drive", "+upload", "--upload", "/opt/logo.png"]),
        "hagelk@psd401.net"
      )
    ).not.toThrow()
  })

  it("still refuses drive +upload on the user slot (impersonation boundary)", () => {
    // Authoring file CONTENT as the user is the exact thing the boundary
    // exists to prevent — the helper form must not be a way around it.
    expect(() =>
      validateWorkspaceCommand(
        user(["drive", "+upload", "--upload", "/opt/logo.png"]),
        "hagelk@psd401.net"
      )
    ).toThrow(/agent-owned/)
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
