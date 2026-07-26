import {
  validateEmailTaskWorkspaceCommand,
  validateWorkspaceCommand,
} from "@/lib/agent-workspace/command-executor"

describe("trusted Workspace command policy", () => {
  it("limits sender-influenced email tasks to one task-insert operation", () => {
    expect(() =>
      validateEmailTaskWorkspaceCommand({
        scope: "user",
        argv: [
          "tasks",
          "tasks",
          "insert",
          "--params",
          '{"tasklist":"@default"}',
          "--json",
          '{"title":"Review email"}',
        ],
      })
    ).not.toThrow()
    expect(() =>
      validateEmailTaskWorkspaceCommand({
        scope: "user",
        argv: ["gmail", "users", "messages", "list"],
      })
    ).toThrow("only insert")
    expect(() =>
      validateEmailTaskWorkspaceCommand({
        scope: "agent",
        argv: ["tasks", "tasks", "insert"],
      })
    ).toThrow("only insert")
  })

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

  it.each([
    ["calendar", "events", "patch"],
    ["calendar", "events", "update"],
    ["docs", "documents", "batchUpdate"],
    ["drive", "permissions", "create"],
    ["sheets", "spreadsheets", "batchUpdate"],
    ["slides", "presentations", "batchUpdate"],
    ["tasks", "tasks", "patch"],
    ["tasks", "tasks", "update"],
  ])("denies %s %s %s without server-recorded provenance", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).toThrow(/server-recorded agent-created provenance/)
  })

  it.each([
    ["calendar", "events", "insert"],
    ["docs", "documents", "create"],
    ["sheets", "spreadsheets", "create"],
    ["slides", "presentations", "create"],
    ["tasks", "tasks", "insert"],
  ])("preserves safe agent create operation %s %s %s", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })
})
