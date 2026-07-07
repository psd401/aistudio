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
  /** Present for Chat uploads — the media.download handle (future fetch path). */
  attachmentResourceName?: string;
}

/**
 * Strip characters that could break the structured prompt header the container
 * renders (bracket delimiters / newlines) and clamp length. Mirrors the
 * sanitization the container applies to cross-user display names.
 */
function sanitizeField(value: string | undefined, maxLen: number): string {
  if (!value) return '';
  return value.replace(/[[\]\n\r]/g, '').trim().slice(0, maxLen);
}

/** Drive file ids are opaque; keep only the safe id character set. */
function sanitizeDriveFileId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 256);
  return cleaned || undefined;
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
