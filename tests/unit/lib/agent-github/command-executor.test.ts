import { validateGitHubCommand } from "@/lib/agent-github/command-executor"

describe("trusted GitHub command policy", () => {
  it.each([
    ["pr", "create", "--repo", "psd401/aistudio"],
    ["issue", "list", "--repo", "psd401/aistudio"],
    ["search", "repos", "aistudio"],
  ])("allows a named operation", (...argv) => {
    expect(() => validateGitHubCommand(argv)).not.toThrow()
  })

  it.each([
    ["pr", "merge", "12"],
    ["api", "repos/psd401/aistudio/pulls/12/merge"],
    ["repo", "delete", "psd401/aistudio"],
    ["alias", "set", "merge", "pr merge"],
  ])("rejects privileged operation", (...argv) => {
    expect(() => validateGitHubCommand(argv)).toThrow(/not allowed|Raw GitHub/)
  })
})
