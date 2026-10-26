import {
  validateGitHubCommand,
  validateScheduledGitHubCommand,
} from "@/lib/agent-github/command-executor"

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
    ["ESC", "a\u001Bb"],
    ["BEL", "a\u0007b"],
    ["DEL", "a\u007Fb"],
  ])("still rejects %s", (_name, body) => {
    expect(() =>
      validateGitHubCommand(["issue", "create", "--repo", "psd401/aistudio", "--body", body])
    ).toThrow(/Invalid GitHub command argument/)
  })
})

// A scheduled run acts as its owner with no human approving each call and may
// read outside content that tries to steer it, so it gets reads only.
describe("scheduled GitHub command policy", () => {
  const repo = ["--repo", "psd401/aistudio"]

  it.each([
    ["issue", "list", ...repo, "--state", "open"],
    ["issue", "view", "42", ...repo],
    ["pr", "list", ...repo, "--state", "open"],
    ["pr", "view", "12", ...repo],
    ["pr", "checks", "12", ...repo],
    ["run", "list", ...repo],
    ["search", "prs", "is:open"],
    ["search", "issues", "is:open"],
    ["auth", "status"],
  ])("allows a read: %s %s", (...argv) => {
    expect(() => validateScheduledGitHubCommand(argv)).not.toThrow()
  })

  it.each([
    ["issue", "create", ...repo, "--title", "t"],
    ["issue", "edit", "42", ...repo, "--title", "t"],
    ["issue", "close", "42", ...repo],
    ["issue", "reopen", "42", ...repo],
    ["issue", "comment", "42", ...repo, "--body", "b"],
    ["pr", "create", ...repo, "--title", "t"],
    ["pr", "comment", "12", ...repo, "--body", "b"],
    ["pr", "review", "12", ...repo, "--approve"],
  ])("refuses a write: %s %s", (...argv) => {
    expect(() => validateGitHubCommand(argv)).not.toThrow()
    expect(() => validateScheduledGitHubCommand(argv)).toThrow(
      /Scheduled runs may only read from GitHub/,
    )
  })

  it("still applies the base policy before the read-only check", () => {
    expect(() =>
      validateScheduledGitHubCommand(["pr", "merge", "12", ...repo]),
    ).toThrow(/not allowed/)
  })
})
