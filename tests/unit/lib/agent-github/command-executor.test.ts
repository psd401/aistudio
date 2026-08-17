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

describe("multi-line argument values", () => {
  // The agent could not file a readable GitHub issue. `hasControlCharacter`
  // rejected every codepoint <= 31, which includes \n and \t — so an issue
  // body, a PR description and a comment, all multi-line by nature, were
  // refused. On 2026-08-17 the agent bisected this from the outside (zero
  // newlines filed instantly, one newline anywhere failed) and had to flatten
  // a 9KB writeup into one run-on paragraph to get issue #1679 filed at all.
  //
  // Safe because arguments reach `gh` through execFile as an argv array: a
  // newline inside a value cannot split it into another argument.
  it("accepts a body containing newlines", () => {
    const body = "## Summary\n\nLine one.\n- bullet\n"
    expect(() =>
      validateGitHubCommand(["issue", "create", "--repo", "psd401/aistudio", "--body", body])
    ).not.toThrow()
  })

  it("accepts tabs and carriage returns", () => {
    expect(() =>
      validateGitHubCommand([
        "issue", "create", "--repo", "psd401/aistudio",
        "--body", "col1\tcol2\r\nrow\n",
      ])
    ).not.toThrow()
  })

  it("accepts a fenced code block", () => {
    const body = "Repro:\n\n```bash\nrun_report.py --school X\n```\n"
    expect(() =>
      validateGitHubCommand(["issue", "create", "--repo", "psd401/aistudio", "--body", body])
    ).not.toThrow()
  })

  it.each([
    ["NUL", "a\u0000b"],
    ["ESC", "a\u001bb"],
    ["BEL", "a\u0007b"],
    ["DEL", "a\u007fb"],
  ])("still rejects %s", (_name, body) => {
    expect(() =>
      validateGitHubCommand(["issue", "create", "--repo", "psd401/aistudio", "--body", body])
    ).toThrow(/Invalid GitHub command argument/)
  })
})
