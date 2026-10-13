'use strict';

/**
 * Deliver a file PRIVATELY into the agent account's Drive (#1885).
 *
 * The counterpart to `artifact-publisher.js`. Same staged upload, different
 * ending: instead of promoting the bytes to an unsigned `public-images/`
 * object, the broker creates the file in `agnt_<user>@psd401.net`'s Drive and
 * shares it with exactly one person — the caller — as a writer. Nothing becomes
 * public-by-link, and ownership is never transferred.
 *
 * This is the default way to hand someone a file. Publishing is the exception,
 * for content that is genuinely meant to be public.
 */

const { requestAgentBroker } = require('./agent-broker');
const { stageUploadedBytes } = require('./staged-upload');

// A Drive delivery does two Google round trips (resumable upload + share)
// behind the broker call, so it needs more than the broker client's 15s default.
const DELIVER_TIMEOUT_MS = 240_000;

/**
 * Deliverable types, extension -> the one content type that extension may
 * carry. Mirrors DRIVE_DELIVERY_CONTENT_TYPES in
 * lib/agent-workspace/drive-delivery.ts, which is the real gate — checking here
 * too turns a broker rejection into a message that names the extension.
 *
 * Note `.docx`, `.xlsx` and `.pptx`: Office files cannot be PUBLISHED at all,
 * which is why a generated deck or workbook used to be unreachable. Drive is
 * where they belong anyway.
 */
const DRIVE_DELIVERABLE_TYPES = new Map([
  ['.csv', 'text/csv'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

// MAX_DRIVE_DELIVERY_BYTES in lib/agent-workspace/drive-delivery.ts.
const MAX_DRIVE_DELIVERY_BYTES = 100 * 1024 * 1024;

/**
 * Create the file in the agent's Drive and share it with the caller.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {string} fileName the name the file gets in Drive (with extension)
 * @param {string} contentType must match the extension
 * @returns {Promise<{fileId: string, webViewLink: string, fileName: string,
 *                    sharedWith: string, ownedBy?: string, reused?: true}>}
 */
async function deliverFileToDrive(bytes, fileName, contentType) {
  const reservationId = await stageUploadedBytes({
    operation: 'drive-upload',
    path: fileName,
    contentType,
    bytes,
  });
  const delivered = await requestAgentBroker(
    '/api/agent/workspace-storage',
    { operation: 'deliver-to-drive', reservationId },
    { timeoutMs: DELIVER_TIMEOUT_MS }
  );
  if (
    typeof delivered.fileId !== 'string' ||
    typeof delivered.webViewLink !== 'string' ||
    typeof delivered.sharedWith !== 'string'
  ) {
    throw new TypeError('Drive delivery verification failed');
  }
  return delivered;
}

module.exports = {
  DRIVE_DELIVERABLE_TYPES,
  MAX_DRIVE_DELIVERY_BYTES,
  deliverFileToDrive,
};
