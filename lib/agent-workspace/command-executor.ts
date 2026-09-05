import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkspaceDownloadUrl,
  putWorkspaceObject,
} from "@/lib/agent-workspace/storage-broker"

export type WorkspaceExecutionScope = "agent" | "user"

export interface WorkspaceCommand {
  scope: WorkspaceExecutionScope
  argv: string[]
}

export interface WorkspaceCommandResult {
  stdout: string
  stderr: string
  /** Present only when the command downloaded binary content. */
  media?: WorkspaceMediaHandoff
  /**
   * Set when bytes were downloaded but could not be handed off. The gws call
   * itself succeeded, so stdout is still valid — this tells the agent why the
   * file is not reachable instead of leaving it to infer that from silence.
   */
  mediaError?: string
}

/**
 * Where a downloaded file was put, and how to fetch it.
 *
 * `workspacePath` is inside the caller's own PRIVATE workspace prefix, never
 * `public-images/` — that prefix is unsigned and public-by-link, so a Drive
 * attachment routed through it would be readable by anyone with the URL.
 * `downloadUrl` is a short-lived presigned GET for the same object, so the
 * agent can read the bytes in the turn that asked for them instead of waiting
 * for the next workspace sync.
 */
export interface WorkspaceMediaHandoff {
  workspacePath: string
  downloadUrl: string
  /**
   * MUST be sent with the GET. createWorkspaceDownloadUrl signs a bounded
   * request with `Range` baked into the signature, so a plain fetch of
   * `downloadUrl` fails on a signature/range mismatch. workspace_sync.py does
   * the same re-attach and treats a mismatch as an invalid download.
   */
  requiredHeaders: { Range: string }
  bytes: number
  contentType?: string
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
  // Chat's `spaces.findDirectMessage` is a GET that resolves the DM space the
  // caller shares with one person; it creates nothing and sends nothing. Being
  // spelled as a verb rather than `get` was the only reason it fell through to
  // the write allowlist and was refused with operation_not_allowed, which left
  // a scheduled digest with no way to find the DM it was supposed to deliver
  // into (agent_failures 14394, 2026-08-28).
  //
  // Classified as a READ rather than allowlisted as a Chat write on purpose:
  // ALLOWED_CHAT_WRITES is derived from ALLOWED_WRITES precisely because every
  // Chat WRITE leaves the owner's Workspace and must reach the outbound audit
  // log. A lookup that sends nothing would enter that derivation as an audit
  // row with a null space and null body, which is not what the log means.
  "finddirectmessage",
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
  "drive comments create",
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
  "forms forms batchupdate",
  "forms forms create",
  "gmail +draft",
  "gmail users drafts create",
  "gmail users drafts update",
  "gmail users labels create",
  // Inbox filters, on the user's own mailbox — the organizing counterpart to
  // the label create directly above, and useless without it: three users asked
  // for skip-inbox-and-label rules or for existing rules to be removed, and
  // every attempt was refused (agent_failures 12909, 13866, 14559).
  //
  // NOTE THE TRUNCATION. operationTokens caps at FOUR positionals, so this one
  // entry is the whole `gmail.users.settings.filters` resource — create, get,
  // list and delete alike, since the fifth token never reaches the operation
  // string. That is the intended grant here (removing a filter is half the
  // ask), but it means this entry cannot be narrowed to a subset of actions
  // without a payload-level validator. Sibling settings resources are NOT
  // covered: `forwardingAddresses`, `sendAs`, `delegates` and `updateVacation`
  // each occupy the fourth token themselves and so remain refused.
  //
  // Requires `gmail.settings.basic`, which `gmail.modify` does NOT imply — see
  // SCOPES_BY_KIND in actions/agent-workspace.actions.ts and the scope gap in
  // requiredWorkspaceScopeGap below, without which this widening would only
  // convert our refusal into a Google 403.
  "gmail users settings filters",
  "gmail users messages modify",
  // Helper forms of writes already permitted in canonical form. Verified
  // against the pinned gws v0.22.5 binary: `sheets +append` and `drive
  // +upload` are real helpers, not model inventions. Each was refused with
  // operation_not_allowed while its canonical twin was allowed, so the
  // capability existed and only the documented spelling of it did not
  // (agent_failures 5979, 7728). `sheets +append` is
  // `sheets spreadsheets values append`; `drive +upload` is a
  // `drive files create` carrying media, and is held to the same agent-only
  // boundary below so it cannot author a file owned by the user.
  "sheets +append",
  "drive +upload",
  // `tasks tasks insert` was allowed but creating the LIST to put tasks in was
  // not, so a request for one list per person failed on all five calls
  // (agent_failures 7134). Same resource family, same slot rules.
  "tasks tasklists insert",
  "sheets spreadsheets batchupdate",
  "sheets spreadsheets create",
  "sheets spreadsheets values append",
  "sheets spreadsheets values update",
  // The BULK form of values.update — one call writes many ranges. Building a
  // workbook is inherently multi-range (a tab per grade), so without this the
  // only route is one values.update per range: dozens of round trips for one
  // report, on the slowest step of the slowest skill. A quartile report stalled
  // here with an empty spreadsheet and every tab still to fill
  // (dev 2026-08-15). It writes the same cells values.update already writes, to
  // the same spreadsheet, under the same scope rules — the bulk spelling was
  // simply missed when the singular one was added.
  "sheets spreadsheets values batchupdate",
  "slides presentations batchupdate",
  "slides presentations create",
  "tasks tasks insert",
  // Reordering / reparenting a task inside a list the agent may already insert
  // into. A user asked for their tasks grouped under four heading tasks; the
  // four headings were inserted on the user slot and then could not be moved,
  // so the list was left worse than before (agent_failures 14031).
  //
  // Placed with `tasks tasks insert` — i.e. NOT in AGENT_ONLY_WRITES — rather
  // than with `patch`/`update`, which are agent-only. A move changes position
  // and parent, never content, and the user slot already permits the strictly
  // larger act of creating the task being moved. Drawing the impersonation
  // line between "may add a task to your list" and "may reorder it" would
  // leave the reported case broken for no gain in containment.
  //
  // The inconsistency with `patch`/`update` was raised and the user-slot
  // placement was confirmed deliberately (2026-08-28). Settled, not overlooked.
  "tasks tasks move",
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
  "drive comments create",
  "drive files copy",
  "drive files create",
  // The helper form of `drive files create` with media attached. It authors
  // file CONTENT, so it sits on the same side of the impersonation boundary as
  // the canonical create: on the user slot the file would be owned by the
  // user, which is the thing that boundary exists to prevent.
  "drive +upload",
  "drive permissions create",
  "drive accessproposals resolve",
  // A Form is authored content in exactly the sense a Doc, Sheet or Slides deck
  // is, and psd-workspace/SKILL.md documents only the agent slot for it ("Create
  // and populate a Form on the agent slot, then hand it over"). Allowlisting the
  // two operations without this entry left `--scope user` — the default when the
  // flag is omitted — authoring a Form under the caller's own identity, which is
  // the impersonation boundary the create operations above are held to.
  "forms forms batchupdate",
  "forms forms create",
  "sheets spreadsheets batchupdate",
  "sheets spreadsheets create",
  "sheets spreadsheets values append",
  // Helper spelling of `sheets spreadsheets values append`, which is agent-only
  // directly above. Allowlisting the helper without this entry would have made
  // the two spellings of one operation disagree about the impersonation
  // boundary, and the helper is the spelling the model actually reaches for.
  "sheets +append",
  "sheets spreadsheets values update",
  // Same reasoning as the singular form directly above: authored content, so
  // it stays on the agent slot. Splitting the two spellings across the
  // impersonation boundary is how `sheets +append` and its canonical form
  // disagreed once already.
  "sheets spreadsheets values batchupdate",
  "slides presentations batchupdate",
  "slides presentations create",
  "tasks tasks patch",
  "tasks tasks update",
])

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata"
const GMAIL_SETTINGS_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic"
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

/**
 * Expand the documented `gmail +draft` helper into the canonical
 * `gmail users drafts create` call that the CLI actually implements.
 *
 * `+draft` does not exist in gws. Verified against the pinned v0.22.5 binary:
 * the gmail helpers are `+send +triage +reply +reply-all +forward +read
 * +watch`, and none of them accepts a `--draft` flag. The CLI answers
 * `unrecognized subcommand +draft, tip: a similar subcommand exists: +read`.
 *
 * That left drafting working only by accident. `gmail users drafts create` is
 * real and allowlisted, so an agent that happened to reach for the canonical
 * form succeeded, while an agent following psd-workspace/SKILL.md — where
 * `+draft` is the worked example in two places — always failed. Same request,
 * different user, different outcome (agent_failures 1112, 1953, 5187, 6078
 * across four users).
 *
 * Phase 1 permits drafting and forbids sending, so drafting must actually
 * work. Building the RFC 5322 message here rather than in the model keeps
 * Rule 9 intact: the agent calls the documented helper and never hand-rolls
 * MIME, which is what it kept failing at when it tried.
 *
 * Only `+draft` is expanded. `+send`, `+reply`, `+reply-all` and `+forward`
 * stay unimplemented and unallowlisted — this opens no path to putting mail on
 * the wire.
 */
const DRAFT_ADDRESS_FLAGS = ["--to", "--cc", "--bcc"] as const
const DRAFT_VALUE_FLAGS = [...DRAFT_ADDRESS_FLAGS, "--subject", "--body"] as const

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value)
}

function encodeHeaderValue(value: string): string {
  // RFC 2047 for anything outside ASCII so a subject with an em dash or an
  // accented name does not corrupt the header.
  if (isPrintableAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

/** Split an address list on the commas that actually separate addresses. */
function splitAddressList(value: string): string[] {
  const addresses: string[] = []
  let current = ""
  let quoted = false
  for (const character of value) {
    if (character === '"') quoted = !quoted
    if (character === "," && !quoted) {
      addresses.push(current)
      current = ""
      continue
    }
    current += character
  }
  addresses.push(current)
  return addresses.filter((address) => address.trim() !== "")
}

/**
 * RFC 2047-encode the display-name half of an address header.
 *
 * `encodeHeaderValue` cannot be applied to an address header wholesale the way
 * it is to a subject: the addr-spec has to stay machine-readable, and
 * `=?UTF-8?B?...?=` wrapping `José <jose@psd401.net>` would leave Gmail
 * nothing to deliver to. Only the display name is encodable, so only the
 * display name is encoded — otherwise it ships as raw UTF-8 bytes, which is
 * what the subject was already fixed not to do.
 *
 * A wholly-ASCII header is returned byte-for-byte, quoting and spacing intact
 * — that is every realistic address this sees, and reformatting it would be
 * all risk and no benefit. A bare non-ASCII addr-spec with no display name
 * (the SMTPUTF8 case) is also left alone: encoding it would break it, and
 * refusing it would reject an address Gmail itself accepts.
 */
function encodeAddressHeader(value: string): string {
  if (isPrintableAscii(value)) return value
  return splitAddressList(value)
    .map((address) => {
      const trimmed = address.trim()
      if (isPrintableAscii(trimmed)) return trimmed
      const angleAddress = /^(.*?)\s*(<[^>]*>)$/.exec(trimmed)
      if (!angleAddress) return trimmed
      const displayName = angleAddress[1].replace(/^"(.*)"$/, "$1")
      const addrSpec = angleAddress[2]
      if (displayName === "") return addrSpec
      return `${encodeHeaderValue(displayName)} ${addrSpec}`
    })
    .join(", ")
}

/**
 * Read the draft helper's own flags, rejecting a repeated flag rather than
 * keeping the first occurrence and silently dropping the rest.
 *
 * `argumentValue` returns the first match, so `--to a@x --to b@y` — passing
 * recipients as repeated flags instead of one comma-separated list, a
 * plausible model habit — addressed only the first and lost the others with no
 * error. That is the same silent-wrong-result shape the rest of this change
 * set exists to remove.
 *
 * Scanning flag-by-flag rather than searching the whole argv also means a
 * `--body` whose text happens to contain `--to` cannot be mistaken for one.
 */
function parseDraftFlags(argv: readonly string[]): {
  values: Map<string, string>
  html: boolean
} {
  const values = new Map<string, string>()
  let html = false
  for (let index = 2; index < argv.length; index += 1) {
    // Named `argument`, not `token`: security/detect-possible-timing-attacks
    // matches any identifier called token in an equality comparison, and this
    // one is a command-line flag, not a credential.
    const argument = argv[index]
    if (argument === "--html") {
      html = true
      continue
    }
    if (!(DRAFT_VALUE_FLAGS as readonly string[]).includes(argument)) continue
    if (values.has(argument)) {
      throw new Error(
        `Workspace draft ${argument} was given more than once; ` +
          "pass a single comma-separated value"
      )
    }
    const value = argv[index + 1]
    if (value === undefined) {
      throw new Error(`Workspace draft ${argument} requires a value`)
    }
    values.set(argument, value)
    index += 1
  }
  return { values, html }
}

function assertNoHeaderInjection(flag: string, value: string): void {
  // A CR or LF in a header value would let model-authored text open a new
  // header (Bcc:, Content-Type:) or end the header block entirely.
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Workspace draft ${flag} must not contain a line break`
    )
  }
}

/**
 * Set `supportsAllDrives` on every Drive call, and `includeItemsFromAllDrives`
 * on listings.
 *
 * Drive v3 hides shared-drive items from clients that do not declare support
 * for them, and it hides them as **404 File not found** — not 403. So a file
 * the caller genuinely has access to, individually shared with them, reads as
 * if it does not exist. The message is indistinguishable from a wrong file id
 * or a share that never landed, which is why it burns a whole turn: there is
 * nothing in it to act on.
 *
 * That is exactly how it failed. A user shared a supervision schedule with
 * their agent account, confirmed the share twice, and `drive files get`
 * answered `error[api]: File not found` on BOTH `--scope agent` and
 * `--scope user`. They re-shared as a native Google Doc; same 404. Nine
 * attempts across eight minutes, then the turn was abandoned
 * (agent_failures 8289 + 8322, prod broker logs 2026-08-14T19:52-20:00).
 *
 * Applied here rather than documented in the skill because the model cannot
 * pass a parameter whose absence produces no hint that it is missing — and
 * because a 404 gives it every reason to conclude the file is gone and stop.
 * Google's own guidance is that clients should always set this.
 *
 * This CANNOT widen access. It declares that the client understands
 * shared-drive semantics; Drive still enforces the file's ACL against the
 * authenticated identity, so a caller with no permission still gets 404. An
 * explicit value from the model is left alone.
 */
export function withSharedDriveSupport(argv: readonly string[]): string[] {
  const tokens = operationTokens(argv)
  // Drive-only: `supportsAllDrives` is a Drive v3 parameter. The Sheets, Docs
  // and Slides APIs reject unknown query parameters, so a Sheet living in a
  // shared drive is reached through `drive files get` and this stays scoped to
  // the Drive surface.
  if (tokens[0] !== "drive") return [...argv]

  const additions: Record<string, boolean> = { supportsAllDrives: true }
  // `supportsAllDrives` alone still omits shared-drive items from a listing;
  // Drive requires both flags before it will return them.
  if (tokens[tokens.length - 1] === "list") {
    additions.includeItemsFromAllDrives = true
  }

  const existing = parseObjectArgument(argv, "--params") ?? {}
  const present = new Set(Object.keys(existing).map((key) => key.toLowerCase()))
  const merged = { ...existing }
  let changed = false
  for (const [key, value] of Object.entries(additions)) {
    if (present.has(key.toLowerCase())) continue
    merged[key] = value
    changed = true
  }
  if (!changed) return [...argv]

  const serialized = JSON.stringify(merged)
  const index = argv.indexOf("--params")
  if (index === -1 || index === argv.length - 1) {
    return [...argv, "--params", serialized]
  }
  const next = [...argv]
  next[index + 1] = serialized
  return next
}

export function expandGmailDraftHelper(argv: readonly string[]): string[] {
  if (argv[0] !== "gmail" || argv[1] !== "+draft") return [...argv]

  const { values, html: isHtml } = parseDraftFlags(argv)

  const headers: string[] = []
  for (const flag of DRAFT_ADDRESS_FLAGS) {
    const value = values.get(flag)
    if (value === undefined) continue
    assertNoHeaderInjection(flag, value)
    const name = flag === "--to" ? "To" : flag === "--cc" ? "Cc" : "Bcc"
    headers.push(`${name}: ${encodeAddressHeader(value)}`)
  }
  if (!headers.some((header) => header.startsWith("To: "))) {
    throw new Error("Workspace draft requires --to")
  }

  const subject = values.get("--subject")
  if (subject !== undefined) {
    assertNoHeaderInjection("--subject", subject)
    headers.push(`Subject: ${encodeHeaderValue(subject)}`)
  }

  const body = values.get("--body") ?? ""
  headers.push("MIME-Version: 1.0")
  headers.push(
    `Content-Type: text/${isHtml ? "html" : "plain"}; charset="UTF-8"`
  )
  // Without this the body goes out as raw UTF-8 bytes under an implied `7bit`,
  // which is off-spec the moment a brief contains an em dash, an accented name
  // or an emoji — all routine in this district's mail. base64 keeps the message
  // 7-bit clean whatever the body holds.
  headers.push("Content-Transfer-Encoding: base64")

  // CRLF per RFC 5322, and base64url because that is what the Gmail API's
  // `message.raw` field expects.
  // The body is base64 because the header above declares it so; the whole
  // message is then base64url because that is what the Gmail API's
  // `message.raw` field takes. Two different encodings, two different reasons —
  // line-wrapped at 76 chars per RFC 2045 so long bodies stay conformant.
  const encodedBody = (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n")
  const mime = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`
  const raw = Buffer.from(mime, "utf8").toString("base64url")

  return [
    "gmail",
    "users",
    "drafts",
    "create",
    "--params",
    JSON.stringify({ userId: "me" }),
    "--json",
    JSON.stringify({ message: { raw } }),
  ]
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
  // The IDs address the endpoint and ride --params; action/role are the body
  // and ride --json. Validate the UNION so neither flag can carry a field the
  // other is being judged on, and so an unrecognized key is caught wherever it
  // was placed.
  const resource = {
    ...(parseObjectArgument(argv, "--params") ?? {}),
    ...(jsonResource(argv) ?? {}),
  }
  if (!jsonResource(argv) && !parseObjectArgument(argv, "--params")) {
    throw new Error(refuse)
  }
  const keys = Object.keys(resource)
  if (keys.length === 0) throw new Error(refuse)
  if (!keys.every((key) => ACCESS_PROPOSAL_FIELDS.has(key.toLowerCase()))) {
    throw new Error(refuse)
  }
  const action =
    typeof resource.action === "string" ? resource.action.toLowerCase() : null
  if (!action || !ACCESS_PROPOSAL_ACTIONS.has(action)) throw new Error(refuse)
  if (action === "deny") return
  if (!isSingleNamedRole(resource.role)) throw new Error(refuse)
}

/**
 * Drive takes the accepted role as either a string or a single-element list.
 * Validate the WHOLE list, not just index 0: `["reader","owner"]` would
 * otherwise pass on its first element while `executeWorkspaceCommand` forwards
 * the original argv — the full, unvalidated JSON — to `gws` verbatim, so
 * nothing downstream re-reads the array. That is exactly the ceiling this
 * check exists to hold.
 */
function isSingleNamedRole(rawRole: unknown): boolean {
  const roles = Array.isArray(rawRole) ? rawRole : [rawRole]
  if (roles.length !== 1) return false
  const role = typeof roles[0] === "string" ? roles[0].toLowerCase() : null
  return !!role && PERMISSION_ROLES_NAMED.has(role)
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


/** Extensions gws may write a binary response to, mapped to a content type. */
const DOWNLOAD_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
}

/**
 * Cap on a rescued download.
 *
 * Deliberately tighter than storage-broker's MAX_PRIVATE_UPLOAD_BYTES (512 MB),
 * which bounds what an agent may deliberately upload. This bounds a file the
 * agent did NOT choose the size of — whatever a caller happened to attach in
 * Drive — and the whole thing is buffered in the web tier's memory on its way
 * through. Both limits still apply; this is not a duplicate of that one.
 */
const MAX_HANDOFF_BYTES = 64 * 1024 * 1024

/**
 * Move a `download.<ext>` gws just wrote into the caller's private workspace
 * and return a short-lived presigned URL for it.
 *
 * The destination is deliberately a fixed, self-describing relative path rather
 * than anything model-supplied: the agent never chooses where these bytes land,
 * so this cannot be steered into overwriting memory files.
 *
 * The key carries the extension, so a download of the same type replaces its
 * predecessor while a different type lands beside it — `downloads/download.pdf`
 * and `downloads/download.png` can coexist. That is a bounded set (one object
 * per extension), not unbounded growth, but it is not "one file" either.
 */
async function handOffDownloadedMedia(
  commandDirectory: string,
  signedWorkspacePrefix: string
): Promise<WorkspaceMediaHandoff | undefined> {
  /* eslint-disable security/detect-non-literal-fs-filename --
   * `commandDirectory` is a broker-created mkdtemp path, never model input,
   * and the filename is matched against a `download.` prefix rather than taken
   * from the command. Nothing here is caller-steerable.
   */
  const entries = await readdir(commandDirectory)
  const downloaded = entries.find((name) => name.startsWith("download."))
  if (!downloaded) return undefined

  // Check the on-disk size BEFORE reading. The tighter cap exists because the
  // file is buffered in web-tier memory, so a check that runs after readFile()
  // does not actually bound peak memory — it only reports the overrun once the
  // allocation has already happened.
  const stats = await stat(join(commandDirectory, downloaded))
  if (stats.size === 0) return undefined
  if (stats.size > MAX_HANDOFF_BYTES) {
    throw new Error(
      `Downloaded file is ${stats.size} bytes, over the ${MAX_HANDOFF_BYTES}-byte hand-off limit`
    )
  }
  const body = await readFile(join(commandDirectory, downloaded))
  /* eslint-enable security/detect-non-literal-fs-filename */

  const extension = downloaded.slice("download.".length).toLowerCase()
  const contentType = DOWNLOAD_CONTENT_TYPES[extension]
  const relativePath = `downloads/${downloaded}`
  await putWorkspaceObject({
    signedWorkspacePrefix,
    relativePath,
    body,
    ...(contentType ? { contentType } : {}),
  })
  const { downloadUrl, requiredHeaders } = await createWorkspaceDownloadUrl(
    signedWorkspacePrefix,
    relativePath
  )
  return {
    workspacePath: relativePath,
    downloadUrl,
    requiredHeaders,
    bytes: body.byteLength,
    ...(contentType ? { contentType } : {}),
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
 *
 * ALWAYS pass `ownerEmail` when the caller is known. It is optional only
 * because a few call sites predate it, and omitting it does not merely skip a
 * check — it silently makes the gate STRICTER, because `isShareToCaller`
 * cannot match a caller it was not told about and the request falls through to
 * the third-party allowlist. That is how the Drive ownership transfer shipped
 * in #1636 failed in production while all four of its unit tests passed: the
 * tests passed the caller, the route's own pre-check did not, and the
 * exemption was dead on every live path (dev agent_failures 496).
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
    // `gmail.modify` does not imply `gmail.settings.basic`, and Gmail requires
    // the latter for every settings.filters call. Without this branch the
    // allowlist entry above would simply move the failure downstream: instead
    // of our operation_not_allowed the user would get an opaque Google 403,
    // which is the shape of the Classroom scope failure from the same week
    // (agent_failures 13536). Reported as a gap instead, this reaches the
    // existing `scope-upgrade-required` path and the skill hands the user a
    // re-authorize link.
    //
    // Every user with an existing refresh token needs that re-consent: a
    // stored token keeps the scope set it was ISSUED with.
    operation === "gmail users settings filters"
      ? {
          scopes: [GMAIL_SETTINGS_SCOPE],
          capability: "manage the filters in your Gmail inbox",
        }
      : operation === "drive files update"
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
  ownerEmail?: string,
): void {
  validateWorkspaceCommand(command, ownerEmail)
  const { operation } = normalizedOperation(command.argv)
  if (command.scope !== "user" || operation !== "tasks tasks insert") {
    throw new Error("Email tasks may only insert a user-owned Google task")
  }
}

export function validateScheduledWorkspaceCommand(
  command: WorkspaceCommand,
  ownerEmail?: string,
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
  validateWorkspaceCommand(command, ownerEmail)
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
  ownerEmail?: string,
  // Optional so every existing caller and test keeps working: without it the
  // media hand-off is simply skipped and behaviour is exactly as before.
  workspacePrefix?: string
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
  // Surfaced on the result rather than thrown: a hand-off problem must not
  // turn a successful Workspace read into a failure.
  let mediaHandoffFailure: unknown
  return new Promise((resolve, reject) => {
    const finish = async (
      error: Error | null,
      stdout: string,
      stderr: string,
    ): Promise<void> => {
      // Rescue any downloaded media BEFORE the directory is destroyed. gws
      // writes a binary response to `download.<ext>` in its cwd, and this
      // directory is deleted on every path, so those bytes used to be
      // unreachable: the caller got {bytes, mimeType, saved_file} describing a
      // file that no longer existed anywhere it could read. Every documented
      // exit was closed — `-o` is refused by design, `files.download` errors,
      // and pdf-to-markdown needs a URL/key/path — so a Drive PDF simply could
      // not be read (agent_failures 7926, 7992).
      let media: WorkspaceMediaHandoff | undefined
      if (!error && workspacePrefix) {
        try {
          media = await handOffDownloadedMedia(commandDirectory, workspacePrefix)
        } catch (mediaError) {
          // A failed hand-off must not fail the command itself: the gws call
          // already succeeded and its stdout is still useful.
          media = undefined
          mediaHandoffFailure = mediaError
        }
      }
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
      resolve({
        stdout,
        stderr,
        ...(media ? { media } : {}),
        ...(mediaHandoffFailure
          ? {
              mediaError:
                mediaHandoffFailure instanceof Error
                  ? mediaHandoffFailure.message
                  : "Downloaded file could not be saved to the workspace",
            }
          : {}),
      })
    }

    try {
      execFile(
        binary,
        // Both transforms run AFTER validation, so the allowlist and every
        // scope gate still judge the operation the model actually asked for
        // (`gmail +draft`), while gws receives the canonical call it
        // implements. A non-draft argv passes through untouched, and
        // withSharedDriveSupport only ever adds Drive query parameters that
        // the validator already permits (DRIVE_PARAM_FIELDS).
        withSharedDriveSupport(expandGmailDraftHelper(command.argv)),
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
