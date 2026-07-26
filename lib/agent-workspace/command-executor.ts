import { execFile } from "node:child_process"

export type WorkspaceExecutionScope = "agent" | "user"

export interface WorkspaceCommand {
  scope: WorkspaceExecutionScope
  argv: string[]
}

export interface WorkspaceCommandResult {
  stdout: string
  stderr: string
}

const READ_ACTIONS = new Set([
  "download",
  "export",
  "get",
  "list",
  "search",
])

const ALLOWED_WRITES = new Set([
  "calendar events insert",
  "calendar events patch",
  "calendar events update",
  "docs documents batchupdate",
  "docs documents create",
  "drive files copy",
  "drive files create",
  "drive permissions create",
  "gmail users drafts create",
  "gmail users drafts update",
  "gmail users messages modify",
  "sheets spreadsheets batchupdate",
  "sheets spreadsheets create",
  "slides presentations batchupdate",
  "slides presentations create",
  "tasks tasks insert",
  "tasks tasks patch",
  "tasks tasks update",
])

const AGENT_ONLY_WRITES = new Set([
  "docs documents batchupdate",
  "docs documents create",
  "drive files copy",
  "drive files create",
  "drive permissions create",
  "sheets spreadsheets batchupdate",
  "sheets spreadsheets create",
  "slides presentations batchupdate",
  "slides presentations create",
])

const MAX_ARGUMENTS = 80
const MAX_ARGUMENT_LENGTH = 200_000
const MAX_TOTAL_LENGTH = 500_000
function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    const allowedWhitespace =
      codePoint === 9 || codePoint === 10 || codePoint === 13
    if (
      codePoint !== undefined &&
      !allowedWhitespace &&
      (codePoint <= 31 || codePoint === 127)
    ) {
      return true
    }
  }
  return false
}

function operationTokens(argv: readonly string[]): string[] {
  const positional: string[] = []
  for (const token of argv) {
    if (token.startsWith("-")) break
    positional.push(token.toLowerCase())
    if (positional.length === 4) break
  }
  return positional
}

function argumentValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index === -1 || index === argv.length - 1) return null
  return argv[index + 1]
}

function parseObjectArgument(argv: readonly string[], flag: string): Record<string, unknown> | null {
  const value = argumentValue(argv, flag)
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizedOperation(argv: readonly string[]): {
  operation: string
  action: string
} {
  const tokens = operationTokens(argv)
  if (tokens.length < 2) {
    throw new Error("Workspace command must name a service and operation")
  }
  const action = tokens[tokens.length - 1]
  return { operation: tokens.join(" "), action }
}

function validateGmailModify(argv: readonly string[]): void {
  const payload = parseObjectArgument(argv, "--json")
  if (!payload) throw new Error("Gmail modify requires a valid --json object")
  const addLabelIds = payload.addLabelIds
  if (
    Array.isArray(addLabelIds) &&
    addLabelIds.some(
      (label) =>
        typeof label === "string" &&
        (label.toUpperCase() === "TRASH" || label.toUpperCase() === "SPAM")
    )
  ) {
    throw new Error("Gmail modify cannot add destructive system labels")
  }
}

function validatePermissionCreate(argv: readonly string[]): void {
  const payload = parseObjectArgument(argv, "--json")
  if (!payload) throw new Error("Permission creation requires a valid --json object")
  const permission =
    (payload.resource && typeof payload.resource === "object"
      ? payload.resource
      : payload.requestBody && typeof payload.requestBody === "object"
        ? payload.requestBody
        : payload) as Record<string, unknown>
  const type = typeof permission.type === "string" ? permission.type.toLowerCase() : ""
  const role = typeof permission.role === "string" ? permission.role.toLowerCase() : ""
  const email =
    typeof permission.emailAddress === "string"
      ? permission.emailAddress.toLowerCase()
      : ""
  const domain =
    typeof permission.domain === "string" ? permission.domain.toLowerCase() : ""

  const namedDistrictUser =
    type === "user" &&
    /^[\w%+.-]+@psd401\.net$/.test(email) &&
    (role === "reader" || role === "commenter" || role === "writer")
  const readOnlyDistrictDomain =
    type === "domain" && domain === "psd401.net" && role === "reader"
  if (!namedDistrictUser && !readOnlyDistrictDomain) {
    throw new Error("Drive sharing is limited to explicit in-district grants")
  }
}

/**
 * Validate the complete argv at the trusted web boundary. The model-facing
 * runtime has no Google credential and no gws binary; only commands accepted
 * here are executed with an owner-derived token.
 */
export function validateWorkspaceCommand(command: WorkspaceCommand): void {
  const { argv, scope } = command
  if (scope !== "agent" && scope !== "user") {
    throw new Error("Workspace scope must be agent or user")
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGUMENTS) {
    throw new Error("Workspace command has an invalid argument count")
  }
  let totalLength = 0
  for (const value of argv) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_ARGUMENT_LENGTH ||
      hasUnsafeControlCharacter(value)
    ) {
      throw new Error("Workspace command contains an invalid argument")
    }
    totalLength += value.length
  }
  if (totalLength > MAX_TOTAL_LENGTH) {
    throw new Error("Workspace command is too large")
  }

  const { operation, action } = normalizedOperation(argv)
  if (READ_ACTIONS.has(action)) return
  if (!ALLOWED_WRITES.has(operation)) {
    throw new Error(`Workspace operation is not allowed: ${operation}`)
  }
  if (scope === "user" && AGENT_ONLY_WRITES.has(operation)) {
    throw new Error("This operation must use the agent-owned Workspace account")
  }
  if (operation === "gmail users messages modify") validateGmailModify(argv)
  if (operation === "drive permissions create") validatePermissionCreate(argv)
}

export async function executeWorkspaceCommand(
  command: WorkspaceCommand,
  accessToken: string
): Promise<WorkspaceCommandResult> {
  validateWorkspaceCommand(command)
  const binary = process.env.GWS_EXECUTABLE || "/usr/local/bin/gws"
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      command.argv,
      {
        env: {
          HOME: "/tmp",
          LANG: "C.UTF-8",
          NODE_ENV: process.env.NODE_ENV,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          GOOGLE_WORKSPACE_CLI_TOKEN: accessToken,
        },
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Workspace CLI failed: ${stderr.slice(0, 500) || error.message}`))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}
