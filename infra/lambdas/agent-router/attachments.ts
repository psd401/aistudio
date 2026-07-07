/**
 * Google Chat attachment + Drive-chip extraction (issue #1138 F1).
 *
 * The Chat message resource carries files the user attached that the router
 * previously dropped on the floor — the agent only ever saw `text`, so it
 * correctly but unhelpfully reported "I don't see any attachment." Two
 * fields carry them:
 *
 *   - `message.attachment[]` — files uploaded in Chat (source
 *     `UPLOADED_CONTENT`) or a Drive file attached via the "+" menu (source
 *     `DRIVE_FILE`). Uploaded content exposes `attachmentDataRef.resourceName`
 *     (a `media.download` handle); Drive files expose `driveDataRef.driveFileId`.
 *   - `message.annotations[]` — inline Drive chips / rich links, carrying
 *     `richLinkMetadata.driveLinkData.driveDataRef.driveFileId`.
 *
 * This module is intentionally dependency-free and pure so it can be unit
 * tested without the Lambda runtime (mirrors rich-envelope.ts). It extracts
 * and normalizes metadata only — it does NOT fetch bytes. Fetching Chat
 * uploads (media.download) and reading Drive files (psd-workspace) happen
 * downstream; the agent is told what arrived and how to reach it.
 */

// --- Raw Google Chat shapes (the subset we read) ----------------------------

export interface ChatDriveDataRef {
  driveFileId?: string;
}

export interface ChatAttachmentDataRef {
  resourceName?: string;
  attachmentUploadToken?: string;
}

export interface ChatAttachment {
  /** Resource name of the attachment, e.g. spaces/.../messages/.../attachments/... */
  name?: string;
  /** Original filename supplied by the uploader. */
  contentName?: string;
  /** MIME type, e.g. application/pdf. */
  contentType?: string;
  /** DRIVE_FILE (attached from Drive) | UPLOADED_CONTENT (uploaded in Chat). */
  source?: 'DRIVE_FILE' | 'UPLOADED_CONTENT' | string;
  attachmentDataRef?: ChatAttachmentDataRef;
  driveDataRef?: ChatDriveDataRef;
}

export interface ChatDriveLinkData {
  driveDataRef?: ChatDriveDataRef;
  mimeType?: string;
}

export interface ChatRichLinkMetadata {
  uri?: string;
  richLinkType?: 'DRIVE_FILE' | string;
  driveLinkData?: ChatDriveLinkData;
}

export interface ChatAnnotation {
  type?: 'RICH_LINK' | 'USER_MENTION' | 'SLASH_COMMAND' | string;
  richLinkMetadata?: ChatRichLinkMetadata;
}

// --- Normalized output ------------------------------------------------------

export interface AgentAttachment {
  /** Human-facing name (filename or a derived label). */
  name: string;
  /** Best-effort MIME type; empty string when Chat didn't supply one. */
  mimeType: string;
  /**
   * Where it came from:
   *   'chat-upload' — uploaded directly in Chat (bytes reachable only via
   *     media.download; not yet fetched for the agent).
   *   'drive-link'  — a Drive file or inline Drive chip (readable via the
   *     psd-workspace skill, subject to sharing/scope).
   */
  source: 'chat-upload' | 'drive-link';
  /** Present for Drive files/chips — the file the agent can try to read. */
  driveFileId?: string;
  /** Present for Chat uploads — the media.download handle the router fetches. */
  attachmentResourceName?: string;
  /**
   * Present for Chat uploads the router successfully fetched: the
   * workspace-relative path (e.g. `attachments/20260706T235133-0-report.pdf`).
   * The same string is the S3 key suffix under the user's workspace prefix
   * AND the path under /home/node/.openclaw/ in the microVM — the container
   * pulls exactly this key before the turn, and a cold microVM restores it
   * via the normal full workspace pull. Absent when the fetch failed (the
   * rendered header then tells the agent the file could not be downloaded).
   */
  workspacePath?: string;
}

/**
 * Strip characters that could break OR spoof the structured prompt header the
 * container renders (`name="…" type="…" source="…"`). Removes the bracket
 * delimiters, newlines, AND the double-quote/backslash that delimit the
 * key/value pairs — otherwise a filename like `a" source="drive-link` could
 * forge trusted metadata (e.g. a fake driveFileId) in the header. `value` is
 * typed `unknown` because it originates from an external Google Chat payload:
 * a non-string (or missing) value must degrade to '', never throw.
 */
function sanitizeField(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLen).replace(/["\\[\]\n\r]/g, '').trim();
}

/** Drive file ids are opaque; keep only the safe id character set. */
function sanitizeDriveFileId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.slice(0, 256).replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned || undefined;
}

/**
 * Build the workspace-relative destination path for a fetched Chat upload.
 *
 * The result is used verbatim as an S3 key suffix (`<prefix>/<path>`) and as
 * a filesystem path under /home/node/.openclaw/ inside the microVM, so it
 * must be safe for both: the filename is reduced to `[A-Za-z0-9._-]`, leading
 * dots are stripped (no hidden files, no `..` traversal), and length is
 * bounded. A UTC timestamp + per-message index prefix keeps repeated uploads
 * of the same filename from overwriting each other.
 */
export function buildWorkspacePath(name: string, index: number, now: Date): string {
  let safeName = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-{2,}/g, '-');
  if (safeName.length > 120) {
    // Preserve the extension when truncating so the agent's tooling can
    // still infer the file type from the name.
    const dot = safeName.lastIndexOf('.');
    const ext = dot > 0 ? safeName.slice(dot).slice(0, 16) : '';
    safeName = safeName.slice(0, 120 - ext.length) + ext;
  }
  if (!safeName) safeName = 'file';
  // 2026-07-06T23:51:33.123Z -> 20260706T235133
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `attachments/${stamp}-${index}-${safeName}`;
}

function deriveDriveName(mimeType: string): string {
  // Chat annotations don't reliably carry a display name; give the agent a
  // readable label based on the Google Doc editor type when we can.
  const map: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form': 'Google Form',
  };
  return map[mimeType] || 'Drive file';
}

/**
 * Extract normalized attachment metadata from a Chat message's `attachment[]`
 * and `annotations[]`. Returns [] when there is nothing to forward. De-dupes
 * Drive references by file id so a chip that is also attached appears once.
 */
export function extractAttachments(message: {
  attachment?: ChatAttachment[];
  annotations?: ChatAnnotation[];
}): AgentAttachment[] {
  const out: AgentAttachment[] = [];
  const seenDriveIds = new Set<string>();

  for (const att of message.attachment ?? []) {
    // External payload — an array hole / null element must not crash the Lambda.
    if (!att || typeof att !== 'object') continue;
    const driveFileId = sanitizeDriveFileId(att.driveDataRef?.driveFileId);
    const resourceName = att.attachmentDataRef?.resourceName;
    const mimeType = sanitizeField(att.contentType, 100);
    if (driveFileId) {
      if (seenDriveIds.has(driveFileId)) continue;
      seenDriveIds.add(driveFileId);
      out.push({
        name: sanitizeField(att.contentName, 256) || deriveDriveName(mimeType),
        mimeType,
        source: 'drive-link',
        driveFileId,
      });
    } else if (resourceName || att.source === 'UPLOADED_CONTENT') {
      out.push({
        name: sanitizeField(att.contentName, 256) || 'uploaded file',
        mimeType,
        source: 'chat-upload',
        ...(resourceName ? { attachmentResourceName: resourceName } : {}),
      });
    }
  }

  for (const ann of message.annotations ?? []) {
    if (!ann || typeof ann !== 'object') continue;
    if (ann.type !== 'RICH_LINK') continue;
    const link = ann.richLinkMetadata;
    const driveFileId = sanitizeDriveFileId(
      link?.driveLinkData?.driveDataRef?.driveFileId
    );
    if (!driveFileId || seenDriveIds.has(driveFileId)) continue;
    seenDriveIds.add(driveFileId);
    const mimeType = sanitizeField(link?.driveLinkData?.mimeType, 100);
    out.push({
      name: deriveDriveName(mimeType),
      mimeType,
      source: 'drive-link',
      driveFileId,
    });
  }

  return out;
}
