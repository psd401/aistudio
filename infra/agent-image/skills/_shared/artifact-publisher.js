'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { requestAgentBroker } = require('./agent-broker');

async function publishArtifact(bytes, extension, contentType) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error('Artifact body must be bytes');
  }
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw new Error('Invalid artifact extension');
  }
  const checksumSha256 = createHash('sha256').update(bytes).digest('base64');
  const prepared = await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'publish',
    path: `${randomUUID()}${extension}`,
    contentType,
    contentLength: bytes.byteLength,
    idempotencyKey: randomUUID(),
    checksumSha256,
  });
  const requiredHeaders = prepared?.requiredHeaders;
  if (
    typeof prepared?.uploadUrl !== 'string' ||
    typeof prepared?.reservationId !== 'string' ||
    !requiredHeaders ||
    typeof requiredHeaders !== 'object' ||
    Array.isArray(requiredHeaders) ||
    Object.keys(requiredHeaders).sort().join(',') !==
      'Content-Length,Content-Type,x-amz-checksum-sha256' ||
    requiredHeaders['Content-Length'] !== String(bytes.byteLength) ||
    requiredHeaders['Content-Type'] !== contentType ||
    requiredHeaders['x-amz-checksum-sha256'] !== checksumSha256
  ) {
    throw new Error('Artifact broker returned an incomplete upload');
  }
  const response = await fetch(prepared.uploadUrl, {
    method: 'PUT',
    headers: requiredHeaders,
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Artifact upload failed: HTTP ${response.status}`);
  }
  const completed = await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'complete-upload',
    reservationId: prepared.reservationId,
  });
  if (typeof completed.publicUrl !== 'string' || typeof completed.key !== 'string') {
    throw new Error('Artifact upload verification failed');
  }
  return { url: completed.publicUrl, key: completed.key };
}

module.exports = { publishArtifact };
