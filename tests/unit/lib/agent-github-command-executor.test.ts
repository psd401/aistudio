import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildGitHubExecutionEnvironment,
  executeGitHubCommand,
  redactGitHubToken,
  validateEmailTaskGitHubCommand,
  validateGitHubCommand,
} from "@/lib/agent-github/command-executor"
import { validatedFs } from "@/lib/filesystem/validated-fs";

function defineGitHubCommandBoundarySuite1Part1() {
  it("limits sender-influenced email tasks to issue creation", () => {
    expect(() =>
      validateEmailTaskGitHubCommand([
        "issue",
        "create",
        "--repo",
        "owner/tasks",
        "--title",
        "Review email",
        "--body",
        "Sender-controlled email excerpt",
        "--label",
        "source:email",
      ])
    ).not.toThrow()
    expect(() =>
      validateEmailTaskGitHubCommand([
        "pr",
        "create",
        "--repo",
        "owner/tasks",
      ])
    ).toThrow("only create a GitHub issue")
    expect(() =>
      validateEmailTaskGitHubCommand([
        "issue",
        "create",
        "--repo",
        "owner/tasks",
        "--assignee",
        "admin",
      ])
    ).toThrow("flag is not allowed")
  })

  it.each([
    [["auth", "status"]],
    [["issue", "list", "--repo", "owner/repo", "--state", "open", "--json", "number,title"]],
    [["pr", "checks", "12", "--repo", "owner/repo", "--watch", "--interval", "10"]],
    [["release", "list", "--repo", "owner/repo", "--exclude-drafts"]],
    [["repo", "list", "owner", "--source", "--limit", "10"]],
    [["run", "view", "123", "--repo", "owner/repo", "--exit-status", "--attempt", "2"]],
    [["search", "repos", "education", "--archived=false", "--limit", "10"]],
    [["workflow", "view", "ci.yml", "--repo", "owner/repo", "--yaml"]],
    [["pr", "diff", "12", "--repo", "owner/repo", "--color", "never", "--patch"]],
  ])("accepts a documented retained command: %p", (argv) => {
    expect(() => validateGitHubCommand(argv)).not.toThrow()
  })

  it.each([
    [["auth", "status", "--show-token"]],
    [["issue", "create", "--repo", "owner/repo", "--body-file", "/etc/passwd"]],
    [["pr", "comment", "12", "--repo", "owner/repo", "-F", "/tmp/secret"]],
    [["repo", "view", "--repo", "owner/repo", "--web"]],
    [["repo", "view", "--repo", "owner/repo", "--config", "browser=!sh"]],
    [["repo", "view", "--repo", "owner/repo", "--", "--upload-pack=evil"]],
    [["issue", "list", "--state", "open"]],
    [["api", "user"]],
  ])("rejects secret/file/config execution vectors: %p", (argv) => {
    expect(() => validateGitHubCommand(argv)).toThrow()
  })

  it("builds a noninteractive execution environment in an invocation-private home", () => {
    const env = buildGitHubExecutionEnvironment(
      "/tmp/gh-broker-private",
      "github_pat_secret"
    )
    expect(env.HOME).toBe("/tmp/gh-broker-private")
    expect(env.GH_CONFIG_DIR).toBe("/tmp/gh-broker-private/gh")
    expect(env.GH_BROWSER).toBe("/usr/bin/false")
    expect(env.BROWSER).toBe("/usr/bin/false")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
    expect(env.GH_PROMPT_DISABLED).toBe("1")
  })

  it("makes the ECS temp mount writable before dropping application privileges", () => {
    const entrypoint = validatedFs.readFileSync(
      join(process.cwd(), "entrypoint.sh"),
      "utf8"
    )
    const prepareTmp = entrypoint.indexOf("if ! chmod 1777 /tmp; then")
    const dropPrivileges = entrypoint.indexOf('exec su-exec nextjs "$@"')

    expect(prepareTmp).toBeGreaterThan(-1)
    expect(dropPrivileges).toBeGreaterThan(prepareTmp)
  })

  it("redacts the injected token and recognizable GitHub tokens from output", () => {
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz123456"
    const output = redactGitHubToken(
      `token=${token} Authorization: bearer ghp_abcdefghijklmnopqrstuvwxyz123456`,
      token
    )
    expect(output).not.toContain(token)
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456")
    expect(output).toContain("[REDACTED]")
  })

  }

function defineGitHubCommandBoundarySuite1Part2() {it("redacts subprocess output and removes the invocation-private directory", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "fake-gh-"))
    const executable = join(fixtureDirectory, "gh")
    validatedFs.writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "printf '%s' \"$GH_CONFIG_DIR\"",
        "printf '%s' \"$GH_TOKEN\" >&2",
      ].join("\n")
    )
    validatedFs.chmodSync(executable, 0o700)
    const previousExecutable = process.env.GH_EXECUTABLE
    process.env.GH_EXECUTABLE = executable
    try {
      const result = await executeGitHubCommand(
        ["auth", "status"],
        "github_pat_abcdefghijklmnopqrstuvwxyz123456"
      )
      expect(result.stderr).toBe("[REDACTED]")
      expect(validatedFs.existsSync(dirname(result.stdout))).toBe(false)
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.GH_EXECUTABLE
      } else {
        process.env.GH_EXECUTABLE = previousExecutable
      }
      rmSync(fixtureDirectory, { recursive: true, force: true })
    }
  })

  it("isolates concurrent homes/configs and redacts both tokens", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "fake-gh-parallel-"))
    const executable = join(fixtureDirectory, "gh")
    validatedFs.writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "if [ -e \"$GH_CONFIG_DIR/marker\" ]; then printf 'contaminated'; fi",
        "mkdir -p \"$GH_CONFIG_DIR\"",
        "printf '%s' \"$GH_TOKEN\" > \"$GH_CONFIG_DIR/marker\"",
        "printf '%s|%s|%s' \"$HOME\" \"$GH_CONFIG_DIR\" \"$GH_TOKEN\"",
      ].join("\n")
    )
    validatedFs.chmodSync(executable, 0o700)
    const previousExecutable = process.env.GH_EXECUTABLE
    process.env.GH_EXECUTABLE = executable
    try {
      const [first, second] = await Promise.all([
        executeGitHubCommand(["auth", "status"], "parallel-token-one"),
        executeGitHubCommand(["auth", "status"], "parallel-token-two"),
      ])
      const [firstHome, firstConfig, firstToken] = first.stdout.split("|")
      const [secondHome, secondConfig, secondToken] = second.stdout.split("|")
      expect(firstHome).not.toBe(secondHome)
      expect(firstConfig).not.toBe(secondConfig)
      expect(firstConfig).toBe(join(firstHome, "gh"))
      expect(secondConfig).toBe(join(secondHome, "gh"))
      expect(firstToken).toBe("[REDACTED]")
      expect(secondToken).toBe("[REDACTED]")
      expect(first.stdout).not.toContain("contaminated")
      expect(second.stdout).not.toContain("contaminated")
      expect(validatedFs.existsSync(firstHome)).toBe(false)
      expect(validatedFs.existsSync(secondHome)).toBe(false)
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.GH_EXECUTABLE
      } else {
        process.env.GH_EXECUTABLE = previousExecutable
      }
      rmSync(fixtureDirectory, { recursive: true, force: true })
    }
  })

  it("redacts the token from subprocess error output", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "fake-gh-error-"))
    const executable = join(fixtureDirectory, "gh")
    validatedFs.writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "printf 'failed with %s' \"$GH_TOKEN\" >&2",
        "exit 7",
      ].join("\n")
    )
    validatedFs.chmodSync(executable, 0o700)
    const previousExecutable = process.env.GH_EXECUTABLE
    process.env.GH_EXECUTABLE = executable
    try {
      await expect(
        executeGitHubCommand(["auth", "status"], "error-token-secret")
      ).rejects.toThrow("failed with [REDACTED]")
      await expect(
        executeGitHubCommand(["auth", "status"], "error-token-secret")
      ).rejects.not.toThrow("error-token-secret")
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.GH_EXECUTABLE
      } else {
        process.env.GH_EXECUTABLE = previousExecutable
      }
      rmSync(fixtureDirectory, { recursive: true, force: true })
    }
  })

  }

function defineGitHubCommandBoundarySuite1Part3() {it("fails with a bounded error when output exceeds the maximum", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "fake-gh-large-"))
    const executable = join(fixtureDirectory, "gh")
    validatedFs.writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "/usr/bin/head -c 1100000 /dev/zero",
      ].join("\n")
    )
    validatedFs.chmodSync(executable, 0o700)
    const previousExecutable = process.env.GH_EXECUTABLE
    process.env.GH_EXECUTABLE = executable
    try {
      let failure: Error | null = null
      try {
        await executeGitHubCommand(["auth", "status"], "large-output-token")
      } catch (error) {
        failure = error instanceof Error ? error : new Error("unknown failure")
      }
      expect(failure).not.toBeNull()
      expect(failure?.message.length).toBeLessThan(2_000)
      expect(failure?.message).not.toContain("large-output-token")
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.GH_EXECUTABLE
      } else {
        process.env.GH_EXECUTABLE = previousExecutable
      }
      rmSync(fixtureDirectory, { recursive: true, force: true })
    }
  })
}

const defineGitHubCommandBoundarySuite1 = () => {
  defineGitHubCommandBoundarySuite1Part1()
  defineGitHubCommandBoundarySuite1Part2()
  defineGitHubCommandBoundarySuite1Part3()
};

describe("GitHub command boundary", defineGitHubCommandBoundarySuite1)
