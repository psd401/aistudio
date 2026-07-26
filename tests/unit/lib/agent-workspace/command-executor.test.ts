import { validateWorkspaceCommand } from "@/lib/agent-workspace/command-executor"

describe("trusted Workspace command policy", () => {
  it("allows bounded read operations", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["gmail", "users", "messages", "list", "--params", '{"userId":"me"}'],
      })
    ).not.toThrow()
  })

  it.each([
    ["gmail", "users", "messages", "send"],
    ["gmail", "users", "messages", "delete"],
    ["calendar", "events", "delete"],
    ["drive", "files", "delete"],
  ])("rejects destructive or external-effect operation %s", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv })
    ).toThrow(/not allowed/)
  })

  it("requires agent ownership for file creation", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["docs", "documents", "create", "--json", "{}"],
      })
    ).toThrow(/agent-owned/)
  })

  it("rejects Gmail modify attempts that add TRASH", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "gmail",
          "users",
          "messages",
          "modify",
          "--json",
          '{"addLabelIds":["TRASH"]}',
        ],
      })
    ).toThrow(/destructive/)
  })

  it("limits Drive shares to explicit district principals", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: [
          "drive",
          "permissions",
          "create",
          "--json",
          '{"type":"user","role":"writer","emailAddress":"outside@example.com"}',
        ],
      })
    ).toThrow(/in-district/)
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: [
          "drive",
          "permissions",
          "create",
          "--json",
          '{"type":"user","role":"reader","emailAddress":"teacher@psd401.net"}',
        ],
      })
    ).not.toThrow()
  })
})
