import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type WorkspaceExecutionScope = "agent" | "user"

export interface WorkspaceCommand {
  scope: WorkspaceExecutionScope
  argv: string[]
}

export interface WorkspaceCommandResult {
  stdout: string
  stderr: string
}

export type WorkspaceCommandRejectionReason = "operation_not_allowed"

export class WorkspaceCommandValidationError extends Error {
  constructor(
    message: string,
    readonly reason: WorkspaceCommandRejectionReason,
    readonly operation: string
  ) {
    super(message)
    this.name = "WorkspaceCommandValidationError"
  }
}

const READ_ACTIONS = new Set([
  "download",
  "export",
  "get",
  "list",
  "search",
])

// Bare mutating verbs only. `+`-prefixed helper verbs are covered by the
// prefix check in validateWorkspaceMutation and must not be enumerated here.
const MUTATING_ACTIONS = new Set([
  "batchdelete",
  "batchmodify",
  "batchupdate",
  "copy",
  "create",
  "delete",
  "emptytrash",
  "forward",
  "insert",
  "modify",
  "move",
  "patch",
  "reply",
  "reply-all",
  "send",
  "stop",
  "trash",
  "untrash",
  "update",
  "watch",
])

const ALLOWED_WRITES = new Set([
  "calendar events insert",
  "calendar events patch",
  "calendar events update",
  "chat +send",
  "chat spaces messages create",
  "docs documents batchupdate",
  "docs documents create",
  "drive files copy",
  "drive files create",
  "drive permissions create",
  // The `+draft` helper is the form psd-workspace/SKILL.md actually documents
  // for composing a draft (it is the worked example in two places), and it is
  // how the model reaches drafting in practice. Only the canonical
  // `gmail users drafts create` was allowlisted, so every documented invocation
  // was refused with operation_not_allowed — leaving the agent no way to draft
  // mail at all. `chat +send` above establishes that helper verbs belong here.
  // Still a draft-only path: `+send`, `+reply`, `+reply-all` and `+forward`
  // remain absent, and the skill-side Phase 1 gate blocks them independently.
  "gmail +draft",
  "gmail users drafts create",
  "gmail users drafts update",
  "gmail users messages modify",
  "sheets spreadsheets batchupdate",
  "sheets spreadsheets create",
  "sheets spreadsheets values append",
  "sheets spreadsheets values update",
  "slides presentations batchupdate",
  "slides presentations create",
  "tasks tasks insert",
  "tasks tasks patch",
  "tasks tasks update",
])

// These mutations were previously refused outright by a provenance gate that
// nothing could satisfy: it threw unconditionally, with no store recording which
// files the agent created and no branch that ever returned success. The name and
// the error described a condition the codebase could not produce, so an agent
// could create a Doc and then never write to or share it — the observed failure
// was three empty, unshareable Docs (agent_failures 798).
//
// They are now ordinary allowlisted writes, confined to the agent slot by
// AGENT_ONLY_WRITES below. That confinement is what remains of the original
// intent: the agent may restructure documents, calendars and tasks owned by its
// own account, and is still refused on the user slot, where the same call would
// be impersonation against the user's own Workspace.

// Derived rather than enumerated: every allowlisted Chat write leaves the
// owner's own Workspace data and therefore has to reach the audit log, so a
// Chat operation cannot be added to ALLOWED_WRITES without being audited.
const ALLOWED_CHAT_WRITES = new Set(
  [...ALLOWED_WRITES].filter((operation) => operation.startsWith("chat "))
)

const AGENT_ONLY_WRITES = new Set([
  ...ALLOWED_CHAT_WRITES,
  // Structural mutations of existing content. On the agent slot these act on
  // the agent's own files; on the user slot the same call would restructure the
  // user's own Workspace as them, which is the impersonation boundary the
  // create operations below are already held to.
  "calendar events patch",
  "calendar events update",
  "docs documents batchupdate",
  "docs documents create",
  "drive files copy",
  "drive files create",
  "drive permissions create",
  "sheets spreadsheets batchupdate",
  "sheets spreadsheets create",
  "sheets spreadsheets values append",
  "sheets spreadsheets values update",
  "slides presentations batchupdate",
  "slides presentations create",
  "tasks tasks patch",
  "tasks tasks update",
])

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata"
const DRIVE_METADATA_FIELDS = new Set([
  "name",
  "starred",
  "description",
  "foldercolorrgb",
  "properties",
  "appproperties",
])
const DRIVE_CONTENT_FLAG =
  /^--(media|media-file|media-body|upload|upload-file|upload-type|content|content-file|data|data-file|body|body-file|text|text-file|file|source|source-file)$/i

const MAX_ARGUMENTS = 80
const MAX_ARGUMENT_LENGTH = 200_000
const MAX_TOTAL_LENGTH = 500_000
const MAX_DIAGNOSTIC_OPERATION_LENGTH = 128
const OPERATION_TOO_LONG = "<operation-too-long>"
const OPERATION_UNAVAILABLE = "<operation-unavailable>"
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

function writesResponseToCallerPath(argv: readonly string[]): boolean {
  return argv.some((value) => {
    const normalized = value.toLowerCase()
    return (
      normalized === "--output" ||
      normalized.startsWith("--output=") ||
      normalized === "-o" ||
      (normalized.length > 2 && normalized.startsWith("-o"))
    )
  })
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

function operationExceedsDiagnosticLimit(argv: readonly string[]): boolean {
  let positionalCount = 0
  let operationLength = 0
  for (const token of argv) {
    if (token.startsWith("-")) break
    const separatorLength = positionalCount === 0 ? 0 : 1
    if (
      operationLength + separatorLength + token.length >
      MAX_DIAGNOSTIC_OPERATION_LENGTH
    ) {
      return true
    }
    operationLength += separatorLength + token.length
    positionalCount += 1
    if (positionalCount === 4) break
  }
  return false
}

export function workspaceOperation(argv: readonly string[]): string {
  if (operationExceedsDiagnosticLimit(argv)) return OPERATION_TOO_LONG
  return operationTokens(argv).join(" ") || OPERATION_UNAVAILABLE
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

function jsonResource(argv: readonly string[]): Record<string, unknown> | null {
  const payload = parseObjectArgument(argv, "--json")
  if (!payload) return null
  const wrapped = payload.resource ?? payload.requestBody ?? payload
  return wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
    ? (wrapped as Record<string, unknown>)
    : null
}

function carriesDriveContent(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    if (DRIVE_CONTENT_FLAG.test(argv[index])) return true
    if (
      argv[index] === "--params" &&
      /uploadtype/i.test(argv[index + 1] ?? "")
    ) {
      return true
    }
  }
  return false
}

function validateUserDriveFolderCreate(argv: readonly string[]): void {
  const resource = jsonResource(argv)
  const mimeType =
    typeof resource?.mimeType === "string"
      ? resource.mimeType.trim().toLowerCase()
      : ""
  const hasTrashField = Object.keys(resource ?? {}).some(
    (key) => key.toLowerCase() === "trashed"
  )
  if (
    !resource ||
    mimeType !== DRIVE_FOLDER_MIME ||
    hasTrashField ||
    carriesDriveContent(argv)
  ) {
    throw new Error(
      "Drive user-owned creation is limited to an untrashed folder without content"
    )
  }
}

function validateUserDriveMetadataUpdate(argv: readonly string[]): void {
  const resource = jsonResource(argv)
  const keys = Object.keys(resource ?? {})
  if (
    !resource ||
    keys.length === 0 ||
    carriesDriveContent(argv) ||
    !keys.every((key) => DRIVE_METADATA_FIELDS.has(key.toLowerCase()))
  ) {
    throw new Error(
      "Drive user-owned updates are limited to approved metadata fields"
    )
  }
}

function normalizedOperation(argv: readonly string[]): {
  operation: string
  action: string
  tokens: string[]
} {
  const tokens = operationTokens(argv)
  if (tokens.length < 2) {
    throw new Error("Workspace command must name a service and operation")
  }
  const action = tokens[tokens.length - 1]
  return { operation: tokens.join(" "), action, tokens }
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

function validateWorkspaceArguments(argv: readonly string[]): void {
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
  if (operationExceedsDiagnosticLimit(argv)) {
    throw new Error("Workspace command contains an invalid operation")
  }
  if (writesResponseToCallerPath(argv)) {
    throw new Error("Workspace command cannot write response data to a file")
  }
}

function validateWorkspaceMutation(
  argv: readonly string[],
  scope: WorkspaceCommand["scope"],
  operation: string,
  action: string,
  tokens: string[]
): void {
  const helperVerb = tokens.find((token) => token.startsWith("+"))
  if (helperVerb === "+read") {
    throw new Error(
      "Workspace read command contains a mutation operation: helper verb `+read` is not permitted; use the canonical read action (e.g. `sheets spreadsheets values get`)"
    )
  }
  if (READ_ACTIONS.has(action)) {
    // A trailing read action must not smuggle an earlier mutation past the
    // write allowlist. `+`-prefixed tokens are always helper verbs, never
    // resources, so screening the whole class covers `+reply`, `+reply-all`
    // and `+forward` without having to enumerate each new helper here.
    if (helperVerb) {
      throw new Error(
        `Workspace read command contains a mutation operation: helper verb \`${helperVerb}\` is not permitted; use the canonical read action (e.g. \`sheets spreadsheets values get\`)`
      )
    }
    if (tokens.slice(0, -1).some((token) => MUTATING_ACTIONS.has(token))) {
      throw new Error("Workspace read command contains a mutation operation")
    }
    return
  }
  if (scope === "user" && operation === "drive files create") {
    validateUserDriveFolderCreate(argv)
    return
  }
  if (scope === "user" && operation === "drive files update") {
    validateUserDriveMetadataUpdate(argv)
    return
  }
  if (!ALLOWED_WRITES.has(operation)) {
    const diagnosticOperation = workspaceOperation(argv)
    throw new WorkspaceCommandValidationError(
      `Workspace operation is not allowed: ${diagnosticOperation}`,
      "operation_not_allowed",
      diagnosticOperation
    )
  }
  if (scope === "user" && AGENT_ONLY_WRITES.has(operation)) {
    throw new Error("This operation must use the agent-owned Workspace account")
  }
  if (operation === "gmail users messages modify") validateGmailModify(argv)
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
  validateWorkspaceArguments(argv)
  const { operation, action, tokens } = normalizedOperation(argv)
  validateWorkspaceMutation(argv, scope, operation, action, tokens)
}

export interface WorkspaceOutboundAudit {
  space: string | null
  textLength: number | null
}

function chatDestinationSpace(argv: readonly string[]): string | null {
  const explicit = argumentValue(argv, "--space")
  if (explicit !== null) return explicit
  const params = parseObjectArgument(argv, "--params")
  return typeof params?.parent === "string" ? params.parent : null
}

function chatMessageText(argv: readonly string[]): string | null {
  const explicit = argumentValue(argv, "--text")
  if (explicit !== null) return explicit
  const body = jsonResource(argv)
  return typeof body?.text === "string" ? body.text : null
}

/**
 * Chat sends are the only allowlisted writes that put content outside the
 * owner's own Workspace data, so the completion log has to record where the
 * message went. `chat +send` carries the destination in `--space`, but the raw
 * create-message form hides it inside `--params`, which the logged operation
 * prefix never reaches. Message bodies are never returned — only their length.
 */
export function outboundMessageAudit(
  argv: readonly string[]
): WorkspaceOutboundAudit | null {
  if (!ALLOWED_CHAT_WRITES.has(operationTokens(argv).join(" "))) {
    return null
  }
  const text = chatMessageText(argv)
  return {
    space: chatDestinationSpace(argv),
    textLength: text === null ? null : text.length,
  }
}

export interface WorkspaceScopeGap {
  scopes: string[]
  capability: string
}

export function requiredWorkspaceScopeGap(
  argv: readonly string[],
  grantedScopeString: string | undefined,
): WorkspaceScopeGap | null {
  if (!grantedScopeString?.trim()) return null
  const tokens = operationTokens(argv)
  const operation = tokens.join(" ")
  const granted = new Set(grantedScopeString.split(/\s+/).filter(Boolean))
  const required: WorkspaceScopeGap | null =
    operation === "drive files update"
      ? {
          scopes: [DRIVE_METADATA_SCOPE],
          capability: "rename and move files in your Drive",
        }
      : (
            operation === "drive files list" ||
            operation === "drive files get" ||
            operation === "drive files export" ||
            (tokens[0] === "drive" &&
              (tokens[1] === "about" || tokens[1] === "changes"))
          )
        ? {
            scopes: [DRIVE_READ_SCOPE],
            capability: "read files in your Drive",
          }
        : null
  if (!required) return null
  const missing = required.scopes.filter((scope) => !granted.has(scope))
  return missing.length > 0
    ? { scopes: missing, capability: required.capability }
    : null
}

export function validateEmailTaskWorkspaceCommand(
  command: WorkspaceCommand,
): void {
  validateWorkspaceCommand(command)
  const { operation } = normalizedOperation(command.argv)
  if (command.scope !== "user" || operation !== "tasks tasks insert") {
    throw new Error("Email tasks may only insert a user-owned Google task")
  }
}

export function validateScheduledWorkspaceCommand(
  command: WorkspaceCommand,
): void {
  // Scheduled runs use the same allowlist as every other invocation mode.
  //
  // This previously refused Chat writes from scheduled runs, on the reasoning
  // that a Chat post messages third parties and so needs live confirmation.
  // That gate blocked the case it was most likely to meet: a recurring job
  // whose owner named its destination spaces when they created the schedule.
  // Authorization given at schedule-creation time is still authorization, and
  // the gate could not tell it apart from an unattended post to an arbitrary
  // space, so it refused both. It also contradicted its own PR (#1459), which
  // enabled agent Chat sends and recorded `scheduled` as an accepted mode.
  //
  // Destinations remain bounded by the agent identity's Chat membership, and
  // every send is recorded by outboundMessageAudit (space + body length).
  validateWorkspaceCommand(command)
}

export async function executeWorkspaceCommand(
  command: WorkspaceCommand,
  accessToken: string
): Promise<WorkspaceCommandResult> {
  validateWorkspaceCommand(command)
  const binary = process.env.GWS_EXECUTABLE || "/usr/local/bin/gws"
  // The pinned gws binary writes non-JSON responses to `download.<ext>` even
  // when the caller does not pass --output. Execute it in an empty, private
  // directory and delete that directory before returning so model-controlled
  // reads can never write into the web application or its writable cache.
  const commandDirectory = await mkdtemp(
    join(tmpdir(), "aistudio-workspace-cli-"),
  )
  return new Promise((resolve, reject) => {
    const finish = async (
      error: Error | null,
      stdout: string,
      stderr: string,
    ): Promise<void> => {
      try {
        await rm(commandDirectory, { recursive: true, force: true })
      } catch {
        reject(new Error("Workspace CLI temporary directory cleanup failed"))
        return
      }
      if (error) {
        reject(
          new Error(
            `Workspace CLI failed: ${stderr.slice(0, 500) || error.message}`,
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    }

    try {
      execFile(
        binary,
        command.argv,
        {
          cwd: commandDirectory,
          env: {
            HOME: commandDirectory,
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
          void finish(error, stdout, stderr)
        },
      )
    } catch (error) {
      void finish(
        error instanceof Error ? error : new Error("Workspace CLI failed"),
        "",
        "",
      )
    }
  })
}
