import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatedFsPromises } from "@/lib/filesystem/validated-fs";

interface CommandPolicy {
  valueFlags: ReadonlySet<string>
  booleanFlags: ReadonlySet<string>
  maxPositionals: number
  requireRepo?: boolean
}

const REPO_FLAGS = ["-R", "--repo"]
const FORMAT_FLAGS = ["--json", "--jq", "--template"]
const LIST_FLAGS = ["--limit", "--state", "--search"]

function policy(input: {
  values?: string[]
  booleans?: string[]
  maxPositionals?: number
  requireRepo?: boolean
}): CommandPolicy {
  return {
    valueFlags: new Set(input.values ?? []),
    booleanFlags: new Set(input.booleans ?? []),
    maxPositionals: input.maxPositionals ?? 0,
    requireRepo: input.requireRepo,
  }
}

/**
 * Each allowed operation has an explicit argv schema. File-reading flags,
 * browser/editor launch flags, raw API access, extension dispatch, and git
 * argument forwarding are absent by construction.
 */
const COMMAND_POLICIES = new Map<string, CommandPolicy>([
  ["auth status", policy({})],
  ["issue close", policy({ values: [...REPO_FLAGS, "--comment", "--reason"], maxPositionals: 1, requireRepo: true })],
  ["issue comment", policy({ values: [...REPO_FLAGS, "--body"], booleans: ["--create-if-none", "--delete-last", "--edit-last", "--yes"], maxPositionals: 1, requireRepo: true })],
  ["issue create", policy({ values: [...REPO_FLAGS, "--title", "--body", "--assignee", "--label", "--milestone", "--project"], requireRepo: true })],
  ["issue edit", policy({ values: [...REPO_FLAGS, "--title", "--body", "--add-assignee", "--remove-assignee", "--add-label", "--remove-label", "--milestone", "--add-project", "--remove-project", "--add-blocked-by", "--remove-blocked-by", "--add-blocking", "--remove-blocking", "--add-sub-issue", "--remove-sub-issue", "--parent", "--type"], booleans: ["--remove-milestone", "--remove-parent", "--remove-type"], maxPositionals: 1, requireRepo: true })],
  ["issue list", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS, ...LIST_FLAGS, "--assignee", "--author", "--label", "--milestone", "--mention", "--app"], requireRepo: true })],
  ["issue reopen", policy({ values: [...REPO_FLAGS, "--comment"], maxPositionals: 1, requireRepo: true })],
  ["issue status", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS], requireRepo: true })],
  ["issue view", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS], booleans: ["--comments"], maxPositionals: 1, requireRepo: true })],
  ["pr checks", policy({ values: [...REPO_FLAGS, "--interval", ...FORMAT_FLAGS], booleans: ["--fail-fast", "--required", "--watch"], maxPositionals: 1, requireRepo: true })],
  ["pr comment", policy({ values: [...REPO_FLAGS, "--body"], booleans: ["--create-if-none", "--delete-last", "--edit-last"], maxPositionals: 1, requireRepo: true })],
  ["pr create", policy({ values: [...REPO_FLAGS, "--title", "--body", "--base", "--head", "--assignee", "--reviewer", "--label", "--milestone", "--project"], booleans: ["--draft"], requireRepo: true })],
  ["pr diff", policy({ values: [...REPO_FLAGS, "--color", "--exclude"], booleans: ["--name-only", "--patch"], maxPositionals: 1, requireRepo: true })],
  ["pr list", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS, ...LIST_FLAGS, "--assignee", "--author", "--base", "--head", "--label", "--app"], booleans: ["--draft"], requireRepo: true })],
  ["pr review", policy({ values: [...REPO_FLAGS, "--body"], booleans: ["--approve", "--comment", "--request-changes"], maxPositionals: 1, requireRepo: true })],
  ["pr status", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS], booleans: ["--conflict-status"], requireRepo: true })],
  ["pr view", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS], booleans: ["--comments"], maxPositionals: 1, requireRepo: true })],
  ["release list", policy({ values: [...REPO_FLAGS, "--limit", "--order", ...FORMAT_FLAGS], booleans: ["--exclude-drafts", "--exclude-pre-releases"], requireRepo: true })],
  ["release view", policy({ values: [...REPO_FLAGS, ...FORMAT_FLAGS], maxPositionals: 1, requireRepo: true })],
  ["repo list", policy({ values: ["--limit", "--language", "--topic", "--visibility", ...FORMAT_FLAGS], booleans: ["--archived", "--fork", "--no-archived", "--source"], maxPositionals: 1 })],
  ["repo view", policy({ values: [...REPO_FLAGS, "--branch", ...FORMAT_FLAGS], maxPositionals: 1, requireRepo: true })],
  ["run list", policy({ values: [...REPO_FLAGS, "--branch", "--commit", "--created", "--event", "--limit", "--status", "--user", "--workflow", ...FORMAT_FLAGS], booleans: ["--all"], requireRepo: true })],
  ["run view", policy({ values: [...REPO_FLAGS, "--attempt", "--job", ...FORMAT_FLAGS], booleans: ["--exit-status", "--log", "--log-failed", "--verbose"], maxPositionals: 1, requireRepo: true })],
  ["run watch", policy({ values: [...REPO_FLAGS, "--interval"], booleans: ["--compact", "--exit-status"], maxPositionals: 1, requireRepo: true })],
  ["search code", policy({ values: ["--extension", "--filename", "--language", "--limit", "--match", "--owner", "--repo", "--size", ...FORMAT_FLAGS], maxPositionals: 1 })],
  ["search commits", policy({ values: ["--author", "--author-date", "--committer", "--committer-date", "--hash", "--limit", "--merge", "--order", "--owner", "--repo", "--sort", "--tree", ...FORMAT_FLAGS], maxPositionals: 1 })],
  ["search issues", policy({ values: ["--app", "--assignee", "--author", "--closed", "--commenter", "--comments", "--created", "--interactions", "--involves", "--label", "--language", "--limit", "--match", "--mentions", "--milestone", "--order", "--owner", "--project", "--reactions", "--repo", "--sort", "--state", "--team-mentions", "--updated", "--visibility", ...FORMAT_FLAGS], booleans: ["--archived", "--include-prs", "--locked", "--no-assignee", "--no-label", "--no-milestone", "--no-project"], maxPositionals: 1 })],
  ["search prs", policy({ values: ["--app", "--assignee", "--author", "--base", "--checks", "--closed", "--commenter", "--comments", "--created", "--head", "--interactions", "--involves", "--label", "--language", "--limit", "--match", "--mentions", "--merged-at", "--milestone", "--order", "--owner", "--project", "--reactions", "--repo", "--review", "--review-requested", "--reviewed-by", "--sort", "--state", "--team-mentions", "--updated", "--visibility", ...FORMAT_FLAGS], booleans: ["--archived", "--draft", "--locked", "--merged", "--no-assignee", "--no-label", "--no-milestone", "--no-project"], maxPositionals: 1 })],
  ["search repos", policy({ values: ["--created", "--followers", "--forks", "--good-first-issues", "--help-wanted-issues", "--include-forks", "--language", "--license", "--limit", "--match", "--number-topics", "--order", "--owner", "--size", "--sort", "--stars", "--topic", "--updated", "--visibility", ...FORMAT_FLAGS], booleans: ["--archived"], maxPositionals: 1 })],
  ["workflow list", policy({ values: [...REPO_FLAGS, "--limit", ...FORMAT_FLAGS], booleans: ["--all"], requireRepo: true })],
  ["workflow view", policy({ values: [...REPO_FLAGS, "--ref"], booleans: ["--yaml"], maxPositionals: 1, requireRepo: true })],
])

const MAX_ARGUMENT_LENGTH = 100_000
const MAX_TOTAL_ARGUMENT_LENGTH = 300_000
const MAX_OUTPUT_BYTES = 1024 * 1024

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true
    }
  }
  return false
}

function flagName(arg: string): string {
  const separator = arg.indexOf("=")
  return separator === -1 ? arg : arg.slice(0, separator)
}

function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

export function validateGitHubCommand(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 100) {
    throw new Error("Invalid GitHub command arguments")
  }
  let total = 0
  for (const arg of argv) {
    if (
      typeof arg !== "string" ||
      arg.length === 0 ||
      arg.length > MAX_ARGUMENT_LENGTH ||
      hasControlCharacter(arg)
    ) {
      throw new Error("Invalid GitHub command argument")
    }
    total += arg.length
  }
  if (total > MAX_TOTAL_ARGUMENT_LENGTH) {
    throw new Error("GitHub command is too large")
  }

  const command = `${argv[0].toLowerCase()} ${argv[1].toLowerCase()}`
  const commandPolicy = COMMAND_POLICIES.get(command)
  if (!commandPolicy) {
    throw new Error(`GitHub operation is not allowed: ${command}`)
  }
  if (command === "auth status" && argv.length !== 2) {
    throw new Error("GitHub auth status does not accept arguments")
  }

  let positionals = 0
  let repository: string | undefined
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--" || !arg) {
      throw new Error("GitHub argument forwarding is not allowed")
    }
    if (!arg.startsWith("-")) {
      positionals += 1
      if (positionals > commandPolicy.maxPositionals) {
        throw new Error(`Too many positional arguments for ${command}`)
      }
      continue
    }
    const name = flagName(arg)
    if (commandPolicy.booleanFlags.has(name)) {
      if (
        arg.includes("=") &&
        !/^(?:true|false)$/.test(arg.slice(arg.indexOf("=") + 1))
      ) {
        throw new Error(`Invalid boolean flag syntax: ${name}`)
      }
      continue
    }
    if (!commandPolicy.valueFlags.has(name)) {
      throw new Error(`GitHub flag is not allowed for ${command}: ${name}`)
    }
    let value: string
    if (arg.includes("=")) {
      value = arg.slice(arg.indexOf("=") + 1)
    } else {
      index += 1
      value = argv[index]
    }
    if (!value || hasControlCharacter(value)) {
      throw new Error(`Missing or invalid value for ${name}`)
    }
    if (name === "--repo" || name === "-R") {
      if (!isRepositoryName(value)) {
        throw new Error("GitHub repository must use owner/name syntax")
      }
      repository = value
    }
  }
  if (commandPolicy.requireRepo && !repository) {
    throw new Error(`GitHub operation requires an explicit --repo owner/name: ${command}`)
  }
}

const EMAIL_TASK_GITHUB_FLAGS = new Set([
  "-R",
  "--repo",
  "--title",
  "--body",
  "--label",
])

export function validateEmailTaskGitHubCommand(
  argv: readonly string[],
): void {
  validateGitHubCommand(argv)
  if (
    argv[0]?.toLowerCase() !== "issue" ||
    argv[1]?.toLowerCase() !== "create"
  ) {
    throw new Error("Email tasks may only create a GitHub issue")
  }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith("-")) {
      throw new Error("Email task issue creation does not accept positionals")
    }
    const name = flagName(arg)
    if (!EMAIL_TASK_GITHUB_FLAGS.has(name)) {
      throw new Error(`Email task GitHub flag is not allowed: ${name}`)
    }
    if (!arg.includes("=")) index += 1
  }
}

export function redactGitHubToken(value: string, token: string): string {
  let redacted = value
  if (token) redacted = redacted.split(token).join("[REDACTED]")
  return redacted
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
}

export function buildGitHubExecutionEnvironment(
  directory: string,
  token: string
): NodeJS.ProcessEnv {
  return {
    BROWSER: "/usr/bin/false",
    EDITOR: "/usr/bin/false",
    GH_BROWSER: "/usr/bin/false",
    GH_CONFIG_DIR: join(directory, "gh"),
    GH_EDITOR: "/usr/bin/false",
    GH_PAGER: "/bin/cat",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EDITOR: "/usr/bin/false",
    GIT_PAGER: "/bin/cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: directory,
    NODE_ENV: process.env.NODE_ENV,
    NO_COLOR: "1",
    PAGER: "/bin/cat",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  }
}

export async function executeGitHubCommand(
  argv: string[],
  token: string
): Promise<{ stdout: string; stderr: string }> {
  validateGitHubCommand(argv)
  const directory = await mkdtemp(join(tmpdir(), "gh-broker-"))
  await validatedFsPromises.chmod(directory, 0o700)
  try {
    return await new Promise((resolve, reject) => {
      execFile(
        process.env.GH_EXECUTABLE || "/usr/local/bin/gh",
        argv,
        {
          encoding: "utf8",
          env: buildGitHubExecutionEnvironment(directory, token),
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: 60_000,
        },
        (error, stdout, stderr) => {
          const safeStdout = redactGitHubToken(stdout.slice(0, MAX_OUTPUT_BYTES), token)
          const safeStderr = redactGitHubToken(stderr.slice(0, MAX_OUTPUT_BYTES), token)
          if (error) {
            reject(
              new Error(
                `GitHub CLI failed: ${safeStderr.slice(0, 500) || redactGitHubToken(error.message, token)}`
              )
            )
            return
          }
          resolve({ stdout: safeStdout, stderr: safeStderr })
        }
      )
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
