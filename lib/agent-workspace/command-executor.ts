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
  // Resolving a Drive access request is the same act as a share, reached from
  // the other direction: the USER asked for access to an agent-owned file and
  // the agent grants it. It was absent from this list, so the one path a user
  // had to recover from the sharing outage was refused too
  // (agent_failures 1986). Held to the same in-district shape rules below.
  "drive accessproposals resolve",
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
  "drive accessproposals resolve",
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
// Query parameters permitted alongside a metadata-only `files update`. These
// select the target and shape the response; none can write content. Parent
// changes (a move) live here rather than in the body. Mirrors
// DRIVE_PARAM_FIELDS in the psd-workspace skill. `uploadType` is absent by
// design — carriesDriveContent refuses it outright.
const DRIVE_PARAM_FIELDS = new Set([
  "fileid",
  "addparents",
  "removeparents",
  "supportsalldrives",
  "fields",
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
  if (carriesDriveContent(argv)) {
    throw new Error(
      "Drive user-owned updates are limited to approved metadata fields"
    )
  }

  // A MOVE carries no request body at all — addParents/removeParents are query
  // parameters. Requiring a `--json` resource therefore refused every move,
  // which is why the Purdy Drive auto-sort schedule failed on each run even
  // though SKILL.md lists move as allowed. This mirrors isMetadataOnlyDriveUpdate
  // in the psd-workspace skill; the two gates must agree or a command passes the
  // skill and then dies here with operation_not_allowed.
  const params = parseObjectArgument(argv, "--params")
  if (params) {
    const paramKeys = Object.keys(params)
    if (!paramKeys.every((key) => DRIVE_PARAM_FIELDS.has(key.toLowerCase()))) {
      throw new Error(
        "Drive user-owned updates are limited to approved query parameters"
      )
    }
  }
  const movesParents =
    !!params &&
    Object.keys(params).some((key) => /^(add|remove)parents$/i.test(key))

  const resource = jsonResource(argv)
  if (resource) {
    const keys = Object.keys(resource)
    if (
      keys.length === 0 ||
      !keys.every((key) => DRIVE_METADATA_FIELDS.has(key.toLowerCase()))
    ) {
      throw new Error(
        "Drive user-owned updates are limited to approved metadata fields"
      )
    }
    return
  }
  // No body: allowed only when --params proves this is a parent move.
  if (!movesParents) {
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

// The two in-district share shapes psd-workspace/SKILL.md documents. Mirrors
// isDocumentedShareShape in the skill — the skill-side gate is a fast, local
// refusal, but a request can reach this executor without passing through it, so
// the shape has to be re-proved here or the policy is advisory only.
// `transferOwnership` and `moveToNewOwnersRoot` are deliberately absent: an
// ownership transfer is never one of the documented shapes, so their presence
// refuses the call.
const PERMISSION_FIELDS = new Set([
  "fileid",
  "type",
  "role",
  "emailaddress",
  "domain",
  "sendnotificationemail",
  "emailmessage",
  "supportsalldrives",
])
const PERMISSION_ROLES_NAMED = new Set(["reader", "commenter", "writer"])
const PSD_DOMAIN = "psd401.net"
const PSD_EMAIL = /^[^\s@]+@psd401\.net$/i

/**
 * Refuse a Drive share that is not one of the documented in-district shapes.
 *
 * Ownership alone is not sufficient: an agent-OWNED file could otherwise be
 * shared to `type: "anyone"`, an external address, or domain-wide `writer`, and
 * ownership could be handed away entirely — all past the in-district boundary
 * the exception is written around. This is an ALLOWLIST and fails closed.
 */
function validateDriveShareShape(
  argv: readonly string[],
  ownerEmail?: string
): void {
  const resource = jsonResource(argv)
  // Handing work back to the person who asked for it is unrestricted: any role,
  // ownership transfer included, on anything the agent can reach. `ownerEmail`
  // is the SERVER-KNOWN caller from the signed invocation context, never an
  // address out of the model's payload, so this cannot be widened by asking.
  if (isShareToCaller(resource, ownerEmail)) return
  if (!isDocumentedShareShape(resource)) {
    throw new Error(
      "Drive shares are limited to the requesting user, an in-district named person (reader/commenter/writer), or a domain-wide reader"
    )
  }
}

/**
 * True when the share's recipient IS the caller — the human who owns this agent.
 *
 * The agent exists to do work for one person, and that person may receive
 * anything it produces or touches, in any role, including having ownership of a
 * Doc transferred to their account. The restrictions elsewhere in this file
 * exist to stop the agent handing data to THIRD parties; they were never meant
 * to stand between the agent and its own owner.
 *
 * Matching is against the server-resolved caller, so a model that writes someone
 * else's address into the payload simply falls through to the normal allowlist.
 */
function isShareToCaller(
  resource: Record<string, unknown> | null,
  ownerEmail?: string
): boolean {
  if (!resource || !ownerEmail) return false
  const type =
    typeof resource.type === "string" ? resource.type.toLowerCase() : null
  if (type !== "user") return false
  const email = resource.emailAddress
  if (typeof email !== "string") return false
  return email.trim().toLowerCase() === ownerEmail.trim().toLowerCase()
}

/** True only for the two documented shapes. Anything else — including an
 *  unrecognized key — is refused. */
function isDocumentedShareShape(
  resource: Record<string, unknown> | null
): boolean {
  if (!resource) return false
  const keys = Object.keys(resource)
  if (keys.length === 0) return false
  if (!keys.every((key) => PERMISSION_FIELDS.has(key.toLowerCase()))) return false

  const type = typeof resource.type === "string" ? resource.type.toLowerCase() : null
  const role = typeof resource.role === "string" ? resource.role.toLowerCase() : null
  if (!type || !role) return false

  if (type === "user") {
    if (!PERMISSION_ROLES_NAMED.has(role)) return false
    const email = resource.emailAddress
    return typeof email === "string" && PSD_EMAIL.test(email.trim())
  }
  if (type === "domain") {
    if (role !== "reader") return false
    const domain = resource.domain
    return typeof domain === "string" && domain.trim().toLowerCase() === PSD_DOMAIN
  }
  // 'anyone', 'group', or anything new: refused.
  return false
}

// Fields on a Drive accessProposals.resolve call. The proposal itself carries
// the requester and the file, so the only things we choose here are whether to
// accept and at what role.
const ACCESS_PROPOSAL_FIELDS = new Set([
  "fileid",
  "proposalid",
  "action",
  "role",
  "view",
  "sendnotification",
])
const ACCESS_PROPOSAL_ACTIONS = new Set(["accept", "deny"])

/**
 * Resolving an access proposal grants the REQUESTER access, so it is held to
 * the same role ceiling as a named-person share: reader, commenter or writer,
 * never owner. `deny` needs no role at all.
 *
 * Allowlist, fails closed — an unparseable payload or an unrecognized key
 * refuses the call.
 */
function validateAccessProposalResolve(argv: readonly string[]): void {
  const refuse = "Access proposals resolve to reader, commenter or writer only"
  const resource = jsonResource(argv) ?? parseObjectArgument(argv, "--params")
  if (!resource) throw new Error(refuse)
  const keys = Object.keys(resource)
  if (keys.length === 0) throw new Error(refuse)
  if (!keys.every((key) => ACCESS_PROPOSAL_FIELDS.has(key.toLowerCase()))) {
    throw new Error(refuse)
  }
  const action =
    typeof resource.action === "string" ? resource.action.toLowerCase() : null
  if (!action || !ACCESS_PROPOSAL_ACTIONS.has(action)) throw new Error(refuse)
  if (action === "deny") return
  // Drive takes the accepted role as either a string or a single-element list.
  // Validate the WHOLE list, not just index 0: `["reader","owner"]` would
  // otherwise pass on its first element while `executeWorkspaceCommand` forwards
  // the original argv — the full, unvalidated JSON — to `gws` verbatim, so
  // nothing downstream re-reads the array. That is exactly the ceiling this
  // check exists to hold.
  const rawRole = resource.role
  const roles = Array.isArray(rawRole) ? rawRole : [rawRole]
  if (roles.length !== 1) throw new Error(refuse)
  const role = typeof roles[0] === "string" ? roles[0].toLowerCase() : null
  if (!role || !PERMISSION_ROLES_NAMED.has(role)) throw new Error(refuse)
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

interface MutationContext {
  operation: string
  action: string
  tokens: string[]
  ownerEmail?: string
}

function validateWorkspaceMutation(
  argv: readonly string[],
  scope: WorkspaceCommand["scope"],
  context: MutationContext
): void {
  const { operation, action, tokens, ownerEmail } = context
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
  if (operation === "drive permissions create") {
    validateDriveShareShape(argv, ownerEmail)
  }
  if (operation === "drive accessproposals resolve") {
    validateAccessProposalResolve(argv)
  }
}

/**
 * Validate the complete argv at the trusted web boundary. The model-facing
 * runtime has no Google credential and no gws binary; only commands accepted
 * here are executed with an owner-derived token.
 */
export function validateWorkspaceCommand(
  command: WorkspaceCommand,
  ownerEmail?: string
): void {
  const { argv, scope } = command
  if (scope !== "agent" && scope !== "user") {
    throw new Error("Workspace scope must be agent or user")
  }
  validateWorkspaceArguments(argv)
  const { operation, action, tokens } = normalizedOperation(argv)
  validateWorkspaceMutation(argv, scope, { operation, action, tokens, ownerEmail })
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

/**
 * Refuse `drive permissions create` on a file the agent slot does not OWN.
 *
 * The static gates prove the caller is on the agent slot and that the permission
 * body has an in-district shape, but neither can prove whose file it is — that
 * needs Drive. The agent slot is a broad Drive credential and users can share
 * their own files INTO the agnt_ account, so without this a user-owned file
 * shared to the agent with sharing rights could be re-shared to another person
 * or domain-wide, straight past the "your own files" boundary the exception is
 * written around.
 *
 * `ownedByMe` is evaluated by Drive against the authenticated identity, which on
 * this path is the agent account, so it answers exactly the right question
 * without plumbing the agent's address through. Shared-drive files report false
 * (the drive owns them, not the agent) and are refused — conservative, and
 * consistent with the documented boundary.
 *
 * Fails CLOSED: a missing fileId, a non-OK response, or a network error refuses
 * the share rather than assuming ownership.
 */
async function assertAgentOwnsSharedFile(
  command: WorkspaceCommand,
  accessToken: string,
  ownerEmail?: string
): Promise<void> {
  const { operation } = normalizedOperation(command.argv)
  if (operation !== "drive permissions create") return
  // Ownership only gates shares to THIRD parties. The caller may receive
  // anything the agent can reach, so a share back to them skips the lookup —
  // and skips a Drive round-trip on the most common share by far.
  if (isShareToCaller(jsonResource(command.argv), ownerEmail)) return

  const fileId = shareTargetFileId(command.argv)
  if (!fileId) {
    throw new Error("Drive share requires a fileId so ownership can be verified")
  }

  if ((await fetchDriveOwnedByMe(fileId, accessToken)) !== true) {
    throw new Error(
      "Drive shares are limited to files the agent owns; ask the file's owner to share it"
    )
  }
}

/** The fileId a share targets, from either the body or the query parameters. */
function shareTargetFileId(argv: readonly string[]): string {
  const resource = jsonResource(argv)
  const params = parseObjectArgument(argv, "--params")
  const raw =
    resource?.fileId ?? resource?.fileID ?? params?.fileId ?? params?.fileID
  return typeof raw === "string" ? raw.trim() : ""
}

/** Ask Drive whether the authenticated identity owns the file. Fails closed. */
async function fetchDriveOwnedByMe(
  fileId: string,
  accessToken: string
): Promise<boolean> {
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
  )
  url.searchParams.set("fields", "ownedByMe")
  url.searchParams.set("supportsAllDrives", "true")
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Drive responded HTTP ${response.status}`)
    }
    const body: unknown = await response.json()
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).ownedByMe === true
    )
  } catch (error) {
    throw new Error(
      `Drive ownership could not be verified for this share: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
}

export async function executeWorkspaceCommand(
  command: WorkspaceCommand,
  accessToken: string,
  ownerEmail?: string
): Promise<WorkspaceCommandResult> {
  validateWorkspaceCommand(command, ownerEmail)
  await assertAgentOwnsSharedFile(command, accessToken, ownerEmail)
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
