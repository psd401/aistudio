/**
 * Private delivery of an agent-made file into the agent account's Drive (#1885).
 *
 * WHY THIS EXISTS. Until now the only outbound path for a file an agent made
 * was `publishArtifact()` — an unsigned, public-by-link S3 object under
 * `public-images/`. `drive +upload` is refused (the Workspace CLI runs in an
 * empty mkdtemp on the web tier, so a container path does not exist there) and
 * Chat replies carry no attachments. So a deck or a spreadsheet full of student
 * data had exactly two outcomes: a public link, or nothing. In a read of 375
 * staff members' agent use (Aug–Oct 2026) about 24 people had student or staff
 * data put on a public link because no private path existed, and at least 6
 * lost Word/Excel/PowerPoint files outright because those types are not even
 * publishable.
 *
 * Each agent already has its own Google account (`agnt_<uniqname>@psd401.net`)
 * with a Drive scope on the DWD grant. This module creates the file IN that
 * account, server-side, then shares it with exactly one person: the agent's own
 * user. That is the rule command-executor.ts already enforces for
 * `drive permissions create` (`isShareToCaller`) — an agent may hand anything
 * it owns to the human it works for, and ownership is never transferred.
 *
 * WHAT THIS MODULE IS NOT. It holds no reservation or staging state: the
 * staged-upload lifecycle stays in storage-broker.ts, which calls in here for
 * the Drive legs. Everything here is pure HTTP against Drive v3 plus the
 * extension/MIME policy, so it is unit-testable with an injected `fetch`.
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"

const log = createLogger({ module: "agent-drive-delivery" })

/**
 * Deliverable types, extension → the ONE content type that extension may carry.
 *
 * Deliberately broader than `PUBLIC_EXTENSIONS` in storage-broker.ts in one
 * direction and narrower in another:
 *
 *  - `.docx` / `.xlsx` / `.pptx` are HERE and absent there. Office files were
 *    blocked from publishing entirely, which is the bug that cost real decks
 *    and spreadsheets. Drive is where an Office file belongs anyway: it opens
 *    in place, keeps its format, and carries an owner.
 *  - `.svg`, `.json`, `.mp3` and `.mp4` are NOT here. They are publish-only
 *    types (charts, recordings, machine payloads) with no private-delivery
 *    demand, and `.svg` in particular is active content — one script-bearing
 *    SVG shared into a human's Drive is a different risk from the same file
 *    behind a UUID'd S3 link. Adding one later is a one-line change plus a
 *    test; guessing now is not.
 *  - `.html` is absent for the same reason it is absent from PUBLIC_EXTENSIONS:
 *    an HTML page is a district document and goes to Atrium.
 *
 * The pairing is enforced, not advisory — a `.xlsx` declared as
 * `application/pdf` is refused. Drive would happily store the mismatch and the
 * user's Excel would then refuse to open its own file.
 */
export const DRIVE_DELIVERY_CONTENT_TYPES: ReadonlyMap<string, string> =
  new Map([
    [".csv", "text/csv"],
    [
      ".docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".md", "text/markdown"],
    [".pdf", "application/pdf"],
    [".png", "image/png"],
    [
      ".pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    [".txt", "text/plain"],
    [".webp", "image/webp"],
    [
      ".xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ])

/**
 * Largest file this path will deliver.
 *
 * Matches MAX_PUBLIC_ARTIFACT_BYTES so "too big to publish" and "too big to
 * deliver" are the same number and the agent never has to learn two limits.
 * Drive's own ceiling is far higher; the bound here exists because the bytes
 * transit the web tier's memory once.
 */
export const MAX_DRIVE_DELIVERY_BYTES = 100 * 1024 * 1024

/** The role the user is given. Never `owner` — ownership is not transferred. */
export const DRIVE_DELIVERY_ROLE = "writer"

export type DriveDeliveryErrorCode =
  /** The extension is not deliverable at all. */
  | "unsupported_type"
  /** The declared content type does not match the extension. */
  | "content_type_mismatch"
  /** Drive refused the upload. Nothing was created. */
  | "create_failed"
  /**
   * The file was created but could NOT be shared, so the user cannot see it.
   * The orphan is removed and the agent is told to retry. There is deliberately
   * no public-link fallback: the whole point of this path is that the file never
   * becomes public-by-link.
   */
  | "share_failed"

export class DriveDeliveryError extends Error {
  constructor(
    readonly code: DriveDeliveryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "DriveDeliveryError"
  }
}

/** The lowercased extension of a delivery file name, including the dot. */
export function driveDeliveryExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".")
  return index === -1 ? "" : fileName.slice(index).toLowerCase()
}

/** True when this extension can be delivered to Drive. */
export function isDriveDeliverableName(fileName: string): boolean {
  return DRIVE_DELIVERY_CONTENT_TYPES.has(driveDeliveryExtension(fileName))
}

/**
 * Resolve the content type a file name must carry, refusing a declared type
 * that disagrees with the extension.
 *
 * `declared` is optional: omitted, the extension's own type is used. A
 * `; charset=utf-8` parameter is tolerated on the declared value because the
 * broker's own normalizer emits it for text types.
 */
export function assertDriveDeliveryContentType(
  fileName: string,
  declared?: string,
): string {
  const extension = driveDeliveryExtension(fileName)
  const expected = DRIVE_DELIVERY_CONTENT_TYPES.get(extension)
  if (!expected) {
    throw new DriveDeliveryError(
      "unsupported_type",
      `Cannot deliver ${extension || "(no extension)"} to Drive — ` +
        `deliverable types are ${[...DRIVE_DELIVERY_CONTENT_TYPES.keys()].join(
          ", ",
        )}.`,
    )
  }
  if (declared === undefined) return expected
  const mediaType = declared.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (mediaType !== expected) {
    throw new DriveDeliveryError(
      "content_type_mismatch",
      `Content type ${mediaType || "(empty)"} does not match ${extension} ` +
        `(${expected}).`,
    )
  }
  return expected
}

/**
 * The browser URL for a Drive file id.
 *
 * Drive returns `webViewLink` on create and that value is what callers get.
 * This is the reconstruction used only on an idempotent REPLAY, where the file
 * id was recorded but the original response was not. It is the canonical form
 * for an uploaded binary file (a Docs-native conversion would differ — this
 * path never converts).
 */
export function driveFileWebViewLink(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}

// The worst case — initiate + upload + share = 210s — must finish inside the
// skill's 240s DELIVER_TIMEOUT_MS (drive-deliverer.js) with room for the token
// mint, the staged S3 read and the DB writes. If the skill gives up first, the
// server still delivers, and the agent's retry stages a NEW reservation and
// shares a second copy.
const DRIVE_TIMEOUT_MS = 30_000
const DRIVE_UPLOAD_TIMEOUT_MS = 150_000

async function driveErrorDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "")
  const flat = raw.replace(/\s+/g, " ").trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat || "(empty body)"
}

export interface DriveDeliveryDeps {
  fetchImpl?: typeof fetch
}

/**
 * A network or timeout failure while creating the file is still a
 * `create_failed`, not a bare TypeError/DOMException: the route only maps a
 * `DriveDeliveryError` to its structured `{ error, code }` response.
 */
async function fetchOrCreateFailed(
  fetchImpl: typeof fetch,
  input: URL | string,
  init: RequestInit,
  step: string,
): Promise<Response> {
  try {
    return await fetchImpl(input, init)
  } catch (error) {
    throw new DriveDeliveryError(
      "create_failed",
      `Drive could not be reached to ${step}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/**
 * Create a file in the authenticated (agent) account's Drive.
 *
 * Uses the RESUMABLE upload protocol for every size rather than branching on
 * one: Drive's multipart form caps out at 5 MB, which a single PowerPoint
 * routinely clears, and a size-conditional second code path is a second code
 * path to get wrong. The session is initiated with the metadata, then the whole
 * body goes in one PUT — resumable without resumption.
 *
 * `fields` is set on the INITIATE request; Drive carries it to the final
 * response, which is where `id` and `webViewLink` come from.
 */
export async function createAgentDriveFile(params: {
  accessToken: string
  name: string
  contentType: string
  /**
   * `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: `BodyInit` only accepts
   * a view over a plain ArrayBuffer, and the AWS SDK hands back the wider
   * `ArrayBufferLike` form. The caller narrows it once rather than every call
   * site casting.
   */
  bytes: Uint8Array<ArrayBuffer>
  deps?: DriveDeliveryDeps
}): Promise<{ fileId: string; webViewLink: string }> {
  const fetchImpl = params.deps?.fetchImpl ?? fetch
  const initiateUrl = new URL(
    "https://www.googleapis.com/upload/drive/v3/files",
  )
  initiateUrl.searchParams.set("uploadType", "resumable")
  initiateUrl.searchParams.set("fields", "id,webViewLink")
  const initiated = await fetchOrCreateFailed(
    fetchImpl,
    initiateUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": params.contentType,
        "X-Upload-Content-Length": String(params.bytes.byteLength),
      },
      body: JSON.stringify({ name: params.name, mimeType: params.contentType }),
      redirect: "error",
      signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
    },
    "open an upload session",
  )
  if (!initiated.ok) {
    throw new DriveDeliveryError(
      "create_failed",
      `Drive refused the upload session (HTTP ${initiated.status}): ${await driveErrorDetail(initiated)}`,
    )
  }
  const sessionUrl = initiated.headers.get("location")
  if (!sessionUrl) {
    throw new DriveDeliveryError(
      "create_failed",
      "Drive returned no resumable upload session",
    )
  }
  const uploaded = await fetchOrCreateFailed(
    fetchImpl,
    sessionUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": params.contentType,
        "Content-Length": String(params.bytes.byteLength),
      },
      body: params.bytes,
      redirect: "error",
      signal: AbortSignal.timeout(DRIVE_UPLOAD_TIMEOUT_MS),
    },
    "upload the file",
  )
  if (!uploaded.ok) {
    throw new DriveDeliveryError(
      "create_failed",
      `Drive upload failed (HTTP ${uploaded.status}): ${await driveErrorDetail(uploaded)}`,
    )
  }
  const body: unknown = await uploaded.json().catch(() => null)
  const created =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const fileId = typeof created.id === "string" ? created.id : ""
  if (!fileId) {
    throw new DriveDeliveryError(
      "create_failed",
      "Drive upload returned no file id",
    )
  }
  return {
    fileId,
    webViewLink:
      typeof created.webViewLink === "string" && created.webViewLink
        ? created.webViewLink
        : driveFileWebViewLink(fileId),
  }
}

/**
 * Share the file with ONE person: the agent's own user, as a writer.
 *
 * This is the only permission this module ever creates. No `type: "anyone"`, no
 * domain grant, no second named person, and no `transferOwnership` — the agent
 * account stays the owner, which is what keeps `assertAgentOwnsSharedFile` in
 * command-executor.ts true for anything the user does with it later.
 *
 * `sendNotificationEmail=false` because the agent pastes the link in the same
 * reply; a Drive notification on top of that is duplicate noise for a file the
 * user just asked for.
 */
export async function shareDriveFileWithUser(params: {
  accessToken: string
  fileId: string
  userEmail: string
  deps?: DriveDeliveryDeps
}): Promise<void> {
  const fetchImpl = params.deps?.fetchImpl ?? fetch
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      params.fileId,
    )}/permissions`,
  )
  url.searchParams.set("sendNotificationEmail", "false")
  url.searchParams.set("fields", "id,type,role,emailAddress")
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "user",
        role: DRIVE_DELIVERY_ROLE,
        emailAddress: params.userEmail,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new DriveDeliveryError(
      "share_failed",
      `Drive could not be reached to share the file with ${params.userEmail}: ${
        error instanceof Error ? error.message : String(error)
      }. The file was not delivered — retry the delivery.`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new DriveDeliveryError(
      "share_failed",
      `Drive refused to share the file with ${params.userEmail} ` +
        `(HTTP ${response.status}): ${await driveErrorDetail(response)}. ` +
        "The file was not delivered — retry the delivery.",
    )
  }
}

/**
 * Remove a file the agent created but could not share.
 *
 * Best effort by design: the share already failed, and the caller's job is to
 * report `share_failed` so the agent retries. An orphan left behind is a file
 * in the agent's own Drive that NO human has access to — untidy, never a leak —
 * so a failure here is logged and swallowed rather than replacing the real
 * error with a cleanup error.
 */
export async function deleteAgentDriveFile(params: {
  accessToken: string
  fileId: string
  deps?: DriveDeliveryDeps
}): Promise<boolean> {
  const fetchImpl = params.deps?.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        params.fileId,
      )}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${params.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(DRIVE_TIMEOUT_MS),
      },
    )
    if (response.ok) return true
    log.warn(
      "Unshared Drive delivery file could not be removed",
      sanitizeForLogging({ fileId: params.fileId, status: response.status }),
    )
    return false
  } catch (error) {
    log.warn(
      "Unshared Drive delivery file could not be removed",
      sanitizeForLogging({
        fileId: params.fileId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}
