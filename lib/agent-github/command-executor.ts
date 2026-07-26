import { execFile } from "node:child_process"

const ALLOWED_COMMANDS = new Set([
  "auth status",
  "issue close",
  "issue comment",
  "issue create",
  "issue edit",
  "issue list",
  "issue reopen",
  "issue status",
  "issue view",
  "pr checks",
  "pr checkout",
  "pr comment",
  "pr create",
  "pr diff",
  "pr list",
  "pr review",
  "pr status",
  "pr view",
  "release download",
  "release list",
  "release view",
  "repo clone",
  "repo fork",
  "repo list",
  "repo view",
  "run download",
  "run list",
  "run view",
  "run watch",
  "search code",
  "search commits",
  "search issues",
  "search prs",
  "search repos",
  "workflow list",
  "workflow view",
])
const VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "--jq",
  "--hostname",
  "--input",
  "-X",
  "--method",
])
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true
    }
  }
  return false
}

function commandWords(argv: readonly string[]): string[] {
  const words: string[] = []
  let skip = false
  for (const arg of argv) {
    if (skip) {
      skip = false
      continue
    }
    if (VALUE_FLAGS.has(arg)) {
      skip = true
      continue
    }
    if (arg.startsWith("-")) continue
    words.push(arg.toLowerCase())
    if (words.length === 2) break
  }
  return words
}

export function validateGitHubCommand(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 100) {
    throw new Error("Invalid GitHub command arguments")
  }
  let total = 0
  for (const arg of argv) {
    if (
      typeof arg !== "string" ||
      arg.length === 0 ||
      arg.length > 100_000 ||
      hasControlCharacter(arg)
    ) {
      throw new Error("Invalid GitHub command argument")
    }
    total += arg.length
  }
  if (total > 300_000) throw new Error("GitHub command is too large")
  const command = commandWords(argv).join(" ")
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`GitHub operation is not allowed: ${command || "<empty>"}`)
  }
  if (argv.some((arg) => arg.toLowerCase() === "api")) {
    throw new Error("Raw GitHub API access is not allowed")
  }
}

export async function executeGitHubCommand(
  argv: string[],
  token: string
): Promise<{ stdout: string; stderr: string }> {
  validateGitHubCommand(argv)
  return new Promise((resolve, reject) => {
    execFile(
      process.env.GH_EXECUTABLE || "/usr/local/bin/gh",
      argv,
      {
        encoding: "utf8",
        env: {
          GH_CONFIG_DIR: "/tmp/gh-broker",
          GH_PROMPT_DISABLED: "1",
          GH_TOKEN: token,
          HOME: "/tmp",
          NODE_ENV: process.env.NODE_ENV,
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        maxBuffer: 2 * 1024 * 1024,
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`GitHub CLI failed: ${stderr.slice(0, 500) || error.message}`))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}
