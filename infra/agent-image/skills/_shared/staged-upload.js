'use strict';

/**
 * The staging half of every two-step broker upload.
 *
 * Both outbound paths — publishing a public artifact and delivering a file into
 * the agent account's Drive (#1885) — are the same three moves: ask the broker
 * for a signed PUT, send the bytes straight to S3, then ask the broker to
 * finish the reservation. Only the finishing move differs, so the staging move
 * lives here once and `artifact-publisher.js` / `drive-deliverer.js` each add
 * their own ending. The bytes never travel through the broker's JSON route.
 */

const { createHash, randomUUID } = require('node:crypto');
const { requestAgentBroker } = require('./agent-broker');

const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The broker binds Content-Length, Content-Type and the SHA-256 into the
 * signature, so a PUT that disagrees with any of them is rejected by S3. Prove
 * the contract came back intact before sending bytes: a missing or altered
 * header here means the PUT fails with an opaque signature error instead.
 */
function hasRequiredUploadContract(prepared, byteLength, contentType, checksumSha256) {
  const headers = prepared?.requiredHeaders;
  if (
    typeof prepared?.uploadUrl !== 'string' ||
    typeof prepared?.reservationId !== 'string' ||
    !headers ||
    typeof headers !== 'object' ||
    Array.isArray(headers)
  ) {
    return false;
  }
  return (
    Object.keys(headers).sort().join(',') ===
      'Content-Length,Content-Type,x-amz-checksum-sha256' &&
    headers['Content-Length'] === String(byteLength) &&
    headers['Content-Type'] === contentType &&
    headers['x-amz-checksum-sha256'] === checksumSha256
  );
}

/**
 * Stage bytes under a fresh reservation and return its id.
 *
 * @param {object} params
 * @param {'publish'|'drive-upload'} params.operation broker staging operation
 * @param {string} params.path  object name the broker keys the target off
 * @param {string} params.contentType
 * @param {Buffer|Uint8Array} params.bytes
 * @returns {Promise<string>} reservationId to pass to the finishing operation
 */
async function stageUploadedBytes({ operation, path, contentType, bytes }) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('Upload body must be bytes');
  }
  const checksumSha256 = createHash('sha256').update(bytes).digest('base64');
  const prepared = await requestAgentBroker('/api/agent/workspace-storage', {
    operation,
    path,
    contentType,
    contentLength: bytes.byteLength,
    idempotencyKey: randomUUID(),
    checksumSha256,
  });
  if (!hasRequiredUploadContract(prepared, bytes.byteLength, contentType, checksumSha256)) {
    throw new Error('Upload broker returned an incomplete upload');
  }
  const response = await fetch(prepared.uploadUrl, {
    method: 'PUT',
    headers: prepared.requiredHeaders,
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }
  return prepared.reservationId;
}

module.exports = { hasRequiredUploadContract, stageUploadedBytes };
